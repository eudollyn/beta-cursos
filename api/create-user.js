import { admin, requireAdminFromRequest, json } from './_firebaseAdmin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok:false, message:'Método não permitido.' });
  try {
    await requireAdminFromRequest(req);
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const phone = String(body.phone || '').trim();
    const password = String(body.password || '').trim();

    if (!name || !email || !password) return json(res, 400, { ok:false, message:'Nome, e-mail e senha são obrigatórios.' });
    if (password.length < 6) return json(res, 400, { ok:false, message:'A senha precisa ter pelo menos 6 caracteres.' });

    const userRecord = await admin.auth().createUser({
      email,
      password,
      displayName: name,
      emailVerified: false,
      disabled: false
    });

    await admin.firestore().collection('users').doc(userRecord.uid).set({
      name,
      email,
      phone,
      role: 'aluno',
      status: 'ativo',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return json(res, 200, { ok:true, uid:userRecord.uid, password });
  } catch (err) {
    const message = err.code === 'auth/email-already-exists' ? 'Já existe um usuário com este e-mail.' : (err.message || 'Erro ao cadastrar aluno.');
    return json(res, err.status || 500, { ok:false, message });
  }
}
