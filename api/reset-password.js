import { admin, requireAdminFromRequest, json } from './_firebaseAdmin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok:false, message:'Método não permitido.' });
  try {
    await requireAdminFromRequest(req);
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const uid = String(body.uid || '').trim();
    const password = String(body.password || '').trim();
    if (!uid || !password) return json(res, 400, { ok:false, message:'Usuário e senha são obrigatórios.' });
    if (password.length < 6) return json(res, 400, { ok:false, message:'A senha precisa ter pelo menos 6 caracteres.' });

    await admin.auth().updateUser(uid, { password });
    await admin.firestore().collection('users').doc(uid).set({ updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge:true });
    return json(res, 200, { ok:true, password });
  } catch (err) {
    return json(res, err.status || 500, { ok:false, message:err.message || 'Erro ao redefinir senha.' });
  }
}
