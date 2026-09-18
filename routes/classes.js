const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const { authMiddleware, requireRole } = require('../middleware/auth');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const HMS_ACCESS_KEY = process.env.HMS_ACCESS_KEY;
const HMS_SECRET = process.env.HMS_SECRET;
const HMS_TEMPLATE_ID = process.env.HMS_TEMPLATE_ID;

// Firestore `in` / `array-contains-any` queries accept at most 30 disjunctive
// values. Chunk larger id lists so we can fetch every record, not just the first batch.
const FIRESTORE_IN_LIMIT = 30;

function chunk(arr, size = FIRESTORE_IN_LIMIT) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/**
 * Fetch class documents whose `id` is in the given list, transparently chunking
 * to respect Firestore's `in` limit.
 */
async function fetchClassesByIds(classIds) {
  const uniqueIds = [...new Set(classIds)].filter(Boolean);
  if (uniqueIds.length === 0) return [];

  const snapshots = await Promise.all(
    chunk(uniqueIds).map((ids) =>
      db.collection('classes').where('id', 'in', ids).get()
    )
  );

  return snapshots.flatMap((snap) => snap.docs.map((doc) => doc.data()));
}

/**
 * Generate a 100ms management token for server-side API calls
 */
function generateManagementToken() {
  const payload = {
    access_key: HMS_ACCESS_KEY,
    type: 'management',
    version: 2,
    iat: Math.floor(Date.now() / 1000),
    nbf: Math.floor(Date.now() / 1000),
  };

  return jwt.sign(payload, HMS_SECRET, {
    algorithm: 'HS256',
    expiresIn: '1h',
    jwtid: uuidv4(),
  });
}

/**
 * Create a 100ms room via REST API
 */
async function createHmsRoom(name, description) {
  const managementToken = generateManagementToken();

  const response = await fetch('https://api.100ms.live/v2/rooms', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${managementToken}`,
    },
    body: JSON.stringify({
      name: name.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase(),
      description,
      template_id: HMS_TEMPLATE_ID,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create 100ms room: ${error}`);
  }

  return response.json();
}

/**
 * POST /api/classes
 * Teacher creates a new class
 */
router.post('/', authMiddleware, requireRole('teacher'), async (req, res) => {
  try {
    const { title, description } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'Class title is required' });
    }

    // Create 100ms room
    const hmsRoom = await createHmsRoom(
      `class-${Date.now()}`,
      description || title
    );

    // Create class document in Firestore
    const classRef = db.collection('classes').doc();
    const classData = {
      id: classRef.id,
      title: title.trim(),
      description: (description || '').trim(),
      teacherId: req.user.uid,
      teacherName: req.user.name,
      roomId: hmsRoom.id,
      status: 'scheduled',
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
    };

    await classRef.set(classData);

    res.status(201).json({
      message: 'Class created successfully',
      class: classData,
    });
  } catch (error) {
    console.error('Create class error:', error);
    res.status(500).json({ error: 'Failed to create class. ' + error.message });
  }
});

/**
 * GET /api/classes
 * List classes — teachers see their own, students see all
 */
router.get('/', authMiddleware, async (req, res) => {
  try {
    let query = db.collection('classes').orderBy('createdAt', 'desc');

    // Teachers only see their own classes
    if (req.user.role === 'teacher') {
      query = db
        .collection('classes')
        .where('teacherId', '==', req.user.uid)
        .orderBy('createdAt', 'desc');
    }

    const snapshot = await query.get();
    const classes = snapshot.docs.map((doc) => doc.data());

    res.json({ classes });
  } catch (error) {
    console.error('List classes error:', error);
    res.status(500).json({ error: 'Failed to fetch classes' });
  }
});

/**
 * GET /api/classes/enrollments/me
 * Student fetches all classes they are enrolled in
 */
router.get('/enrollments/me', authMiddleware, async (req, res) => {
  try {
    const enrollmentsSnapshot = await db
      .collection('enrollments')
      .where('studentId', '==', req.user.uid)
      .get();
      
    const classIds = enrollmentsSnapshot.docs.map((doc) => doc.data().classId);

    if (classIds.length === 0) {
      return res.json({ classes: [] });
    }

    // Fetch every enrolled class (chunked to respect Firestore's `in` limit),
    // then sort newest-first to match the main listing order.
    const classes = await fetchClassesByIds(classIds);
    classes.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    res.json({ classes });
  } catch (error) {
    console.error('List enrollments error:', error);
    res.status(500).json({ error: 'Failed to fetch enrollments' });
  }
});

/**
 * GET /api/classes/:id
 * Get single class details
 */
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const classDoc = await db.collection('classes').doc(req.params.id).get();

    if (!classDoc.exists) {
      return res.status(404).json({ error: 'Class not found' });
    }

    res.json({ class: classDoc.data() });
  } catch (error) {
    console.error('Get class error:', error);
    res.status(500).json({ error: 'Failed to fetch class details' });
  }
});

/**
 * POST /api/classes/:id/enroll
 * Student enrolls in a class
 */
router.post('/:id/enroll', authMiddleware, requireRole('student'), async (req, res) => {
  try {
    const classId = req.params.id;
    const classDoc = await db.collection('classes').doc(classId).get();

    if (!classDoc.exists) {
      return res.status(404).json({ error: 'Class not found' });
    }

    const enrollmentId = `${req.user.uid}_${classId}`;
    const enrollmentRef = db.collection('enrollments').doc(enrollmentId);
    const enrollmentDoc = await enrollmentRef.get();

    if (enrollmentDoc.exists) {
      return res.status(400).json({ error: 'Already enrolled in this class' });
    }

    await enrollmentRef.set({
      id: enrollmentId,
      studentId: req.user.uid,
      studentName: req.user.name,
      studentEmail: req.user.email,
      classId: classId,
      enrolledAt: new Date().toISOString(),
    });

    res.status(201).json({ message: 'Successfully enrolled in class' });
  } catch (error) {
    console.error('Enroll error:', error);
    res.status(500).json({ error: 'Failed to enroll in class' });
  }
});

/**
 * GET /api/classes/:id/students
 * Teacher fetches all students enrolled in their class
 */
router.get('/:id/students', authMiddleware, requireRole('teacher'), async (req, res) => {
  try {
    const classId = req.params.id;
    const classDoc = await db.collection('classes').doc(classId).get();

    if (!classDoc.exists) {
      return res.status(404).json({ error: 'Class not found' });
    }

    if (classDoc.data().teacherId !== req.user.uid) {
      return res.status(403).json({ error: 'Unauthorized to view students for this class' });
    }

    const enrollmentsSnapshot = await db
      .collection('enrollments')
      .where('classId', '==', classId)
      .get();
      
    const students = enrollmentsSnapshot.docs.map((doc) => ({
      studentId: doc.data().studentId,
      studentName: doc.data().studentName,
      studentEmail: doc.data().studentEmail,
      enrolledAt: doc.data().enrolledAt,
    }));

    res.json({ students });
  } catch (error) {
    console.error('Fetch students error:', error);
    res.status(500).json({ error: 'Failed to fetch enrolled students' });
  }
});

/**
 * PATCH /api/classes/:id/start
 * Teacher starts the class (sets status to "live")
 */
router.patch('/:id/start', authMiddleware, requireRole('teacher'), async (req, res) => {
  try {
    const classRef = db.collection('classes').doc(req.params.id);
    const classDoc = await classRef.get();

    if (!classDoc.exists) {
      return res.status(404).json({ error: 'Class not found' });
    }

    const classData = classDoc.data();

    if (classData.teacherId !== req.user.uid) {
      return res.status(403).json({ error: 'You can only start your own classes' });
    }

    if (classData.status === 'live') {
      return res.status(400).json({ error: 'Class is already live' });
    }

    if (classData.status === 'ended') {
      return res.status(400).json({ error: 'Class has already ended' });
    }

    await classRef.update({
      status: 'live',
      startedAt: new Date().toISOString(),
    });

    res.json({ message: 'Class is now live!', status: 'live' });
  } catch (error) {
    console.error('Start class error:', error);
    res.status(500).json({ error: 'Failed to start class' });
  }
});

/**
 * PATCH /api/classes/:id/stop
 * Teacher ends the current session but keeps the class open so it can be
 * restarted later (e.g. the next day). The class returns to "scheduled"
 * status, allowing a future PATCH /start to bring it back "live".
 */
router.patch('/:id/stop', authMiddleware, requireRole('teacher'), async (req, res) => {
  try {
    const classRef = db.collection('classes').doc(req.params.id);
    const classDoc = await classRef.get();

    if (!classDoc.exists) {
      return res.status(404).json({ error: 'Class not found' });
    }

    const classData = classDoc.data();

    if (classData.teacherId !== req.user.uid) {
      return res.status(403).json({ error: 'You can only stop your own classes' });
    }

    if (classData.status === 'ended') {
      return res.status(400).json({ error: 'Class has already ended and cannot be restarted' });
    }

    if (classData.status !== 'live') {
      return res.status(400).json({ error: 'Class is not currently live' });
    }

    await classRef.update({
      status: 'scheduled',
      startedAt: null,
      lastSessionEndedAt: new Date().toISOString(),
    });

    res.json({ message: 'Session ended. Class can be restarted later.', status: 'scheduled' });
  } catch (error) {
    console.error('Stop class error:', error);
    res.status(500).json({ error: 'Failed to stop class' });
  }
});

/**
 * PATCH /api/classes/:id/end
 * Teacher ends the class for good (sets status to "ended").
 * An ended class cannot be restarted.
 */
router.patch('/:id/end', authMiddleware, requireRole('teacher'), async (req, res) => {
  try {
    const classRef = db.collection('classes').doc(req.params.id);
    const classDoc = await classRef.get();

    if (!classDoc.exists) {
      return res.status(404).json({ error: 'Class not found' });
    }

    const classData = classDoc.data();

    if (classData.teacherId !== req.user.uid) {
      return res.status(403).json({ error: 'You can only end your own classes' });
    }

    if (classData.status === 'ended') {
      return res.status(400).json({ error: 'Class has already ended' });
    }

    await classRef.update({
      status: 'ended',
      endedAt: new Date().toISOString(),
    });

    res.json({ message: 'Class ended', status: 'ended' });
  } catch (error) {
    console.error('End class error:', error);
    res.status(500).json({ error: 'Failed to end class' });
  }
});

module.exports = router;
