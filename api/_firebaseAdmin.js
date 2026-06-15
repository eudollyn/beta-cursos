import admin from 'firebase-admin';

function privateKey() {
  const key = process.env.FIREBASE_PRIVATE_KEY || '';
  return key.replace(/\\n/g, '\n');
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: privateKey()
    })
  });
}

export { admin };

export async function requireAdminFromToken(idToken) {
  if (!idToken) {
    const error = new Error('Token de autenticação ausente.');
    error.status = 401;
    throw error;
  }
  const decoded = await admin.auth().verifyIdToken(idToken);
  const snap = await admin.firestore().collection('users').doc(decoded.uid).get();
  const profile = snap.exists ? snap.data() : null;
  if (!profile || profile.role !== 'admin' || profile.status !== 'ativo') {
    const error = new Error('Acesso administrativo negado.');
    error.status = 403;
    throw error;
  }
  return { uid: decoded.uid, profile };
}

export async function requireAdminFromRequest(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const idToken = header.startsWith('Bearer ') ? header.slice(7) : '';
  return requireAdminFromToken(idToken);
}

export function json(res, status, data) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}
