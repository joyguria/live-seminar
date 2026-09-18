const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const { authMiddleware, requireRole } = require('../middleware/auth');

// Firestore `in` queries accept at most 30 disjunctive values.
const FIRESTORE_IN_LIMIT = 30;

function chunk(arr, size = FIRESTORE_IN_LIMIT) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function byNewestFirst(list) {
  return list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

/**
 * POST /api/messages
 * Teacher creates an announcement for enrolled students
 */
router.post('/', authMiddleware, requireRole('teacher'), async (req, res) => {
  try {
    const { title, body } = req.body;

    if (!title || !body) {
      return res.status(400).json({ error: 'Title and body are required' });
    }

    const messageRef = db.collection('messages').doc();
    const messageData = {
      id: messageRef.id,
      title: title.trim(),
      body: body.trim(),
      teacherId: req.user.uid,
      teacherName: req.user.name,
      createdAt: new Date().toISOString(),
    };

    await messageRef.set(messageData);

    res.status(201).json({
      message: 'Announcement sent successfully',
      announcement: messageData,
    });
  } catch (error) {
    console.error('Create message error:', error);
    res.status(500).json({ error: 'Failed to create message' });
  }
});

/**
 * GET /api/messages
 * Fetch announcements scoped to the caller:
 *  - Teachers see only their own announcements.
 *  - Students see announcements from teachers of the classes they are enrolled in.
 *
 * Queries avoid Firestore composite-index requirements by filtering on a single
 * field and sorting in memory.
 */
router.get('/', authMiddleware, async (req, res) => {
  try {
    // Teachers: only their own announcements.
    if (req.user.role === 'teacher') {
      const snapshot = await db
        .collection('messages')
        .where('teacherId', '==', req.user.uid)
        .get();

      const messages = byNewestFirst(snapshot.docs.map((doc) => doc.data()));
      return res.json({ messages });
    }

    // Students: announcements from teachers of their enrolled classes.
    const enrollmentsSnapshot = await db
      .collection('enrollments')
      .where('studentId', '==', req.user.uid)
      .get();

    const classIds = [
      ...new Set(enrollmentsSnapshot.docs.map((doc) => doc.data().classId)),
    ].filter(Boolean);

    if (classIds.length === 0) {
      return res.json({ messages: [] });
    }

    // Resolve the teachers of those classes (chunked to respect the `in` limit).
    const classSnapshots = await Promise.all(
      chunk(classIds).map((ids) =>
        db.collection('classes').where('id', 'in', ids).get()
      )
    );
    const teacherIds = [
      ...new Set(
        classSnapshots.flatMap((snap) =>
          snap.docs.map((doc) => doc.data().teacherId)
        )
      ),
    ].filter(Boolean);

    if (teacherIds.length === 0) {
      return res.json({ messages: [] });
    }

    const messageSnapshots = await Promise.all(
      chunk(teacherIds).map((ids) =>
        db.collection('messages').where('teacherId', 'in', ids).get()
      )
    );

    const messages = byNewestFirst(
      messageSnapshots.flatMap((snap) => snap.docs.map((doc) => doc.data()))
    );

    res.json({ messages });
  } catch (error) {
    console.error('List messages error:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

module.exports = router;
