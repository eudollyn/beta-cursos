// Camada de dados online: Firebase Auth + Cloud Firestore + APIs Vercel.
// Mantém os mesmos nomes usados pelas páginas para preservar a estrutura visual do site.

if (!window.firebase || !window.BETA_FIREBASE_CONFIG) {
  throw new Error('Firebase não foi carregado corretamente. Confira os scripts no HTML.');
}

firebase.initializeApp(window.BETA_FIREBASE_CONFIG);
const auth = firebase.auth();
const db = firebase.firestore();

let authReadyResolve;
const authReady = new Promise(resolve => { authReadyResolve = resolve; });
auth.onAuthStateChanged(user => authReadyResolve(user));

async function getAuthUser() {
  await authReady;
  return auth.currentUser;
}

async function getIdToken(forceRefresh = false) {
  const user = await getAuthUser();
  return user ? user.getIdToken(forceRefresh) : null;
}

async function api(path, options = {}) {
  const headers = options.headers ? { ...options.headers } : {};
  const token = await getIdToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const config = {
    method: options.method || 'GET',
    headers,
    body: options.body
  };

  if (options.json !== undefined) {
    config.headers['Content-Type'] = 'application/json';
    config.body = JSON.stringify(options.json);
  }

  const response = await fetch(path, config);
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { ok:false, message:text || 'Erro inesperado.' }; }
  if (!response.ok || data.ok === false) {
    const err = new Error(data.message || data.error || 'Erro na solicitação.');
    err.status = response.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function currentUser() {
  const user = await getAuthUser();
  if (!user) return null;
  const doc = await db.collection('users').doc(user.uid).get();
  if (!doc.exists) {
    await auth.signOut();
    return null;
  }
  const profile = { id:user.uid, uid:user.uid, email:user.email, ...doc.data() };
  if (profile.status !== 'ativo') {
    await auth.signOut();
    throw new Error('Seu acesso está bloqueado. Procure a equipe responsável pelo curso.');
  }
  return profile;
}

async function requireAuth(role) {
  try {
    const user = await currentUser();
    if (!user) {
      location.href = 'login.html';
      return null;
    }
    if (role && user.role !== role) {
      location.href = user.role === 'admin' ? 'admin.html' : 'plataforma.html';
      return null;
    }
    return user;
  } catch (err) {
    toast(err.message || 'Faça login novamente.');
    setTimeout(() => location.href = 'login.html', 800);
    return null;
  }
}

async function login(email, password) {
  const credential = await auth.signInWithEmailAndPassword(email.trim().toLowerCase(), password);
  const doc = await db.collection('users').doc(credential.user.uid).get();
  if (!doc.exists) {
    await auth.signOut();
    throw new Error('Usuário sem perfil liberado. Procure a administração.');
  }
  const user = { id: credential.user.uid, uid: credential.user.uid, email: credential.user.email, ...doc.data() };
  if (user.status !== 'ativo') {
    await auth.signOut();
    throw new Error('Seu acesso está bloqueado. Procure a equipe responsável pelo curso.');
  }
  return { ok:true, user };
}

async function logout() {
  try { await auth.signOut(); } catch {}
  location.href = 'login.html';
}

function sortByOrder(a, b) {
  return Number(a.order || 0) - Number(b.order || 0);
}

function docWithId(doc) {
  return { id: doc.id, ...doc.data() };
}

async function getPublishedModules() {
  const snap = await db.collection('modules').where('status', '==', 'publicado').get();
  return snap.docs.map(docWithId).sort(sortByOrder);
}

async function getAdminModules() {
  const snap = await db.collection('modules').get();
  return snap.docs.map(docWithId).sort(sortByOrder);
}

async function getModuleLessons(moduleId, includeDraft = false) {
  let ref = db.collection('lessons');
  let snap = await ref.get();
  let lessons = snap.docs.map(docWithId);
  if (moduleId) lessons = lessons.filter(l => l.moduleId === moduleId);
  if (!includeDraft) lessons = lessons.filter(l => l.status === 'publicado');
  return lessons.sort(sortByOrder);
}

async function getAllLessonsAdmin() {
  const snap = await db.collection('lessons').get();
  return snap.docs.map(docWithId).sort(sortByOrder);
}

async function getProgressMap() {
  const user = await currentUser();
  const map = new Map();
  if (!user) return map;
  const snap = await db.collection('progress').where('userId', '==', user.uid).get();
  snap.docs.forEach(doc => {
    const item = doc.data();
    map.set(item.lessonId, !!item.done);
  });
  return map;
}

function isLessonDoneFromMap(progressMap, lessonId) {
  return !!progressMap.get(lessonId);
}

async function setLessonDone(lessonId, done = true) {
  const user = await currentUser();
  if (!user) throw new Error('Sessão expirada. Faça login novamente.');
  const id = `${user.uid}_${lessonId}`;
  await db.collection('progress').doc(id).set({
    userId: user.uid,
    lessonId,
    done: !!done,
    completedAt: done ? firebase.firestore.FieldValue.serverTimestamp() : null,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  }, { merge:true });
}

function moduleProgressFromLessons(progressMap, lessons) {
  if (!lessons.length) return 0;
  const done = lessons.filter(l => isLessonDoneFromMap(progressMap, l.id)).length;
  return Math.round((done / lessons.length) * 100);
}

function generatePassword() {
  const part = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `Beta${part}`;
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
}

function copyText(text) {
  navigator.clipboard?.writeText(text).then(() => toast('Copiado para a área de transferência.'));
}

function toast(message) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#F5E7D7;color:#1B1B1B;padding:12px 16px;border-radius:999px;font-weight:700;z-index:9999;box-shadow:0 16px 50px rgba(0,0,0,.35);max-width:calc(100% - 32px);text-align:center';
    document.body.appendChild(el);
  }
  el.textContent = message;
  clearTimeout(window.__toastTimeout);
  window.__toastTimeout = setTimeout(() => el.remove(), 3600);
}

document.addEventListener('click', (event) => {
  const toggle = event.target.closest('[data-menu-toggle]');
  if (toggle) document.querySelector('.nav-links')?.classList.toggle('open');
  const logoutBtn = event.target.closest('[data-logout]');
  if (logoutBtn) logout();
});
