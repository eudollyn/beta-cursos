async function initLoginPage() {
  const form = document.querySelector('#loginForm');
  if (!form) return;

  try {
    const session = await currentUser();
    if (session) {
      location.href = session.role === 'admin' ? 'admin.html' : 'plataforma.html';
      return;
    }
  } catch {}

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const message = document.querySelector('#loginMessage');
    const btn = form.querySelector('button[type="submit"]');

    try {
      btn.disabled = true;
      btn.textContent = 'Entrando...';

      const result = await login(form.email.value, form.password.value);

      message.textContent = 'Acesso liberado. Redirecionando...';
      message.className = 'helper success';

      setTimeout(() => {
        location.href = result.user.role === 'admin' ? 'admin.html' : 'plataforma.html';
      }, 350);
    } catch (err) {
      message.textContent = err.message || 'Não foi possível entrar.';
      message.className = 'helper error';
      btn.disabled = false;
      btn.textContent = 'Acessar';
    }
  });
}

async function initPlatformPage() {
  const user = await requireAuth('aluno');
  if (!user) return;

  document.querySelectorAll('[data-user-name]').forEach(el => {
    el.textContent = (user.name || 'aluno').split(' ')[0];
  });

  const target = document.querySelector('#modulesList');
  if (!target) return;

  try {
    const [modulesSnap, lessonsSnap, progressMap] = await Promise.all([
      db.collection('modules').get(),
      db.collection('lessons').where('status', '==', 'publicado').get(),
      getProgressMap().catch(() => new Map())
    ]);

    const allModules = modulesSnap.docs
      .map(docWithId)
      .sort((a, b) => Number(a.order || 0) - Number(b.order || 0));

    const publishedLessons = lessonsSnap.docs
      .map(docWithId)
      .sort((a, b) => Number(a.order || 0) - Number(b.order || 0));

    const modules = allModules.filter(module => {
      const hasPublishedLesson = publishedLessons.some(lesson => lesson.moduleId === module.id);
      return module.status === 'publicado' || hasPublishedLesson;
    });

    if (!modules.length && !publishedLessons.length) {
      target.innerHTML = `
        <div class="panel">
          <h2>Nenhum módulo publicado.</h2>
          <p>Assim que a administração liberar o conteúdo, ele aparecerá aqui.</p>
        </div>
      `;

      const progressEl = document.querySelector('#generalProgress');
      if (progressEl) progressEl.textContent = '0%';

      const progressBar = document.querySelector('#generalProgressBar');
      if (progressBar) progressBar.style.width = '0%';

      return;
    }

    if (!modules.length && publishedLessons.length) {
      target.innerHTML = `
        <article class="module-card">
          <span class="badge">Aulas disponíveis</span>

          <div>
            <h3>Curso Beta</h3>
            <p>Aulas publicadas sem módulo vinculado corretamente.</p>
          </div>

          <div class="progressbar" aria-label="Progresso">
            <span style="width:0%"></span>
          </div>

          <div class="lesson-list">
            ${publishedLessons.map(lesson => `
              <div class="lesson-item">
                <div>
                  <h4>${isLessonDoneFromMap(progressMap, lesson.id) ? '✓ ' : ''}${escapeHtml(lesson.title)}</h4>
                  <p>${escapeHtml(lesson.duration || 'Aula')} · ${escapeHtml(lesson.description || '')}</p>
                </div>

                <a class="btn small secondary" href="aula.html?id=${lesson.id}">
                  Assistir
                </a>
              </div>
            `).join('')}
          </div>
        </article>
      `;

      return;
    }

    target.innerHTML = modules.map(module => {
      const lessons = publishedLessons
        .filter(lesson => lesson.moduleId === module.id)
        .sort((a, b) => Number(a.order || 0) - Number(b.order || 0));

      const progress = moduleProgressFromLessons(progressMap, lessons);

      return `
        <article class="module-card">
          <span class="badge">Módulo ${escapeHtml(module.order || '')}</span>

          <div>
            <h3>${escapeHtml(module.title || 'Módulo sem título')}</h3>
            <p>${escapeHtml(module.description || '')}</p>
          </div>

          <div class="progressbar" aria-label="Progresso">
            <span style="width:${progress}%"></span>
          </div>

          <div class="lesson-list">
            ${
              lessons.length
                ? lessons.map(lesson => `
                    <div class="lesson-item">
                      <div>
                        <h4>${isLessonDoneFromMap(progressMap, lesson.id) ? '✓ ' : ''}${escapeHtml(lesson.title)}</h4>
                        <p>${escapeHtml(lesson.duration || 'Aula')} · ${escapeHtml(lesson.description || '')}</p>
                      </div>

                      <a class="btn small secondary" href="aula.html?id=${lesson.id}">
                        Assistir
                      </a>
                    </div>
                  `).join('')
                : '<p class="helper">As aulas deste módulo serão disponibilizadas em breve.</p>'
            }
          </div>
        </article>
      `;
    }).join('');

    const totalLessons = publishedLessons.length;
    const totalDone = publishedLessons.filter(l => isLessonDoneFromMap(progressMap, l.id)).length;
    const pct = totalLessons ? Math.round((totalDone / totalLessons) * 100) : 0;

    const progressEl = document.querySelector('#generalProgress');
    if (progressEl) progressEl.textContent = `${pct}%`;

    const progressBar = document.querySelector('#generalProgressBar');
    if (progressBar) progressBar.style.width = `${pct}%`;
  } catch (error) {
    console.error('PLATFORM_RENDER_ERROR:', error);

    target.innerHTML = `
      <div class="panel">
        <h2>Erro ao carregar módulos</h2>
        <p>${escapeHtml(error.message || 'Não foi possível buscar os dados do curso.')}</p>
      </div>
    `;
  }
}

async function initLessonPage() {
  const user = await requireAuth('aluno');
  if (!user) return;

  const params = new URLSearchParams(location.search);
  const lessonId = params.get('id');

  const [modules, allLessons, progressMap] = await Promise.all([
    getPublishedModules(),
    getModuleLessons('', false),
    getProgressMap()
  ]);

  const lesson = allLessons.find(l => l.id === lessonId);

  if (!lesson) {
    document.querySelector('#lessonArea').innerHTML = `
      <div class="panel">
        <h2>Aula não encontrada</h2>
        <p>Volte para a plataforma e escolha uma aula disponível.</p>
        <a class="btn" href="plataforma.html">Voltar</a>
      </div>
    `;
    return;
  }

  const module = modules.find(m => m.id === lesson.moduleId);

  document.querySelector('#lessonTitle').textContent = lesson.title;
  document.querySelector('#lessonModule').textContent = module?.title || 'Curso Beta';
  document.querySelector('#lessonDescription').textContent = lesson.description || '';
  document.querySelector('#lessonDuration').textContent = lesson.duration || 'Aula';

  const doneBtn = document.querySelector('#doneBtn');

  const updateDone = () => {
    const done = isLessonDoneFromMap(progressMap, lesson.id);
    doneBtn.textContent = done ? '✓ Aula concluída' : 'Marcar como concluída';
    doneBtn.classList.toggle('orange', !done);
  };

  doneBtn.addEventListener('click', async () => {
    const done = isLessonDoneFromMap(progressMap, lesson.id);

    await setLessonDone(lesson.id, !done);

    progressMap.set(lesson.id, !done);

    updateDone();

    toast(!done ? 'Aula marcada como concluída.' : 'Conclusão removida.');
  });

  updateDone();

  const videoMount = document.querySelector('#videoMount');

  if (lesson.videoUrl) {
    videoMount.innerHTML = `
      <video controls playsinline controlsList="nodownload" src="${escapeHtml(lesson.videoUrl)}"></video>
    `;
  } else {
    videoMount.innerHTML = `
      <div class="video-placeholder">
        <div>
          <h2>Vídeo em breve</h2>
          <p>O administrador pode enviar o arquivo desta aula no painel administrativo.</p>
        </div>
      </div>
    `;
  }

  const lessons = allLessons
    .filter(l => l.moduleId === lesson.moduleId)
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0));

  const currentIndex = lessons.findIndex(l => l.id === lesson.id);
  const next = lessons[currentIndex + 1];
  const prev = lessons[currentIndex - 1];

  document.querySelector('#nextLesson').innerHTML = next
    ? `<a class="btn" href="aula.html?id=${next.id}">Próxima aula</a>`
    : '<a class="btn secondary" href="plataforma.html">Voltar à plataforma</a>';

  document.querySelector('#prevLesson').innerHTML = prev
    ? `<a class="btn secondary" href="aula.html?id=${prev.id}">Aula anterior</a>`
    : '<a class="btn secondary" href="plataforma.html">Todos os módulos</a>';
}

async function initAdminPage() {
  const user = await requireAuth('admin');
  if (!user) return;

  document.querySelectorAll('[data-admin-name]').forEach(el => {
    el.textContent = (user.name || 'admin').split(' ')[0];
  });

  setupTabs();
  setupForms();

  await refreshAdmin();
}

async function refreshAdmin() {
  await Promise.all([
    renderAdminDashboard(),
    renderStudents(),
    renderModulesAdmin(),
    renderLessonsAdmin()
  ]);
}

function setupTabs() {
  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-tab]').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));

      document.querySelectorAll(`[data-tab="${btn.dataset.tab}"]`).forEach(b => {
        b.classList.add('active');
      });

      document.querySelector(`#${btn.dataset.tab}`)?.classList.add('active');
    });
  });
}

async function renderAdminDashboard() {
  const target = document.querySelector('#adminDashboard');
  if (!target) return;

  const [studentsSnap, modulesSnap, lessonsSnap] = await Promise.all([
    db.collection('users').where('role', '==', 'aluno').get(),
    db.collection('modules').get(),
    db.collection('lessons').where('status', '==', 'publicado').get()
  ]);

  target.innerHTML = `
    <div class="grid-3">
      <div class="meta-card">
        <strong>${studentsSnap.size}</strong>
        <span>Alunos cadastrados</span>
      </div>

      <div class="meta-card">
        <strong>${modulesSnap.size}</strong>
        <span>Módulos criados</span>
      </div>

      <div class="meta-card">
        <strong>${lessonsSnap.size}</strong>
        <span>Aulas publicadas</span>
      </div>
    </div>

    <div class="notice">
      <strong>Online:</strong> alunos, módulos, aulas e progresso ficam salvos no Firebase.
      Os vídeos são enviados pelo painel e armazenados no Vercel Blob.
    </div>
  `;
}

async function getStudentsWithProgress() {
  const [studentsSnap, lessonsSnap, progressSnap] = await Promise.all([
    db.collection('users').where('role', '==', 'aluno').get(),
    db.collection('lessons').where('status', '==', 'publicado').get(),
    db.collection('progress').get()
  ]);

  const lessons = lessonsSnap.docs.map(docWithId);
  const progress = progressSnap.docs.map(docWithId);

  return studentsSnap.docs.map(d => {
    const student = docWithId(d);
    const done = progress.filter(p => p.userId === student.id && p.done).length;

    return {
      ...student,
      progress: lessons.length ? Math.round((done / lessons.length) * 100) : 0
    };
  });
}

async function renderStudents() {
  const target = document.querySelector('#studentsTable');
  if (!target) return;

  const students = await getStudentsWithProgress();

  target.innerHTML = students.map(student => `
    <tr>
      <td>
        <strong>${escapeHtml(student.name)}</strong>
        <br>
        <span class="helper">${escapeHtml(student.phone || '-')}</span>
      </td>

      <td>${escapeHtml(student.email)}</td>

      <td>
        <span class="badge ${student.status === 'ativo' ? 'done' : ''}">
          ${escapeHtml(student.status)}
        </span>
      </td>

      <td>${student.progress || 0}%</td>

      <td class="actions">
        <button class="btn small secondary" data-copy-access="${student.id}" data-email="${escapeHtml(student.email)}">Copiar link</button>
        <button class="btn small secondary" data-reset-pass="${student.id}">Nova senha</button>
        <button class="btn small danger" data-toggle-student="${student.id}">
          ${student.status === 'ativo' ? 'Bloquear' : 'Ativar'}
        </button>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="5">Nenhum aluno cadastrado.</td></tr>';

  target.querySelectorAll('[data-copy-access]').forEach(btn => {
    btn.addEventListener('click', () => {
      copyText(`Acesso ao curso Beta\nLink: ${location.origin}/login.html\nE-mail: ${btn.dataset.email}\nSenha: enviada pela administração`);
    });
  });

  target.querySelectorAll('[data-toggle-student]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ref = db.collection('users').doc(btn.dataset.toggleStudent);
      const snap = await ref.get();
      const status = snap.data()?.status === 'ativo' ? 'bloqueado' : 'ativo';

      await ref.update({
        status,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      await renderStudents();
      await renderAdminDashboard();
    });
  });

  target.querySelectorAll('[data-reset-pass]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const pass = generatePassword();

      await api('/api/reset-password', {
        method: 'POST',
        json: {
          uid: btn.dataset.resetPass,
          password: pass
        }
      });

      await renderStudents();

      copyText(`Acesso ao curso Beta\nLink: ${location.origin}/login.html\nSenha: ${pass}`);

      toast('Nova senha gerada e copiada. Copie também o e-mail do aluno na tabela.');
    });
  });
}

async function renderModulesAdmin() {
  const modules = await getAdminModules();

  const target = document.querySelector('#modulesTable');
  const moduleSelect = document.querySelector('#lessonModuleId');

  if (moduleSelect) {
    moduleSelect.innerHTML = modules.map(m => `
      <option value="${m.id}">${escapeHtml(m.order)} - ${escapeHtml(m.title)}</option>
    `).join('');
  }

  if (!target) return;

  target.innerHTML = modules.map(module => `
    <tr>
      <td>${escapeHtml(module.order)}</td>

      <td>
        <strong>${escapeHtml(module.title)}</strong>
        <br>
        <span class="helper">${escapeHtml(module.description || '')}</span>
      </td>

      <td>
        <span class="badge ${module.status === 'publicado' ? 'done' : ''}">
          ${escapeHtml(module.status)}
        </span>
      </td>

      <td class="actions">
        <button class="btn small secondary" data-edit-module="${module.id}">Editar</button>
        <button class="btn small danger" data-delete-module="${module.id}">Excluir</button>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="4">Nenhum módulo cadastrado.</td></tr>';

  target.querySelectorAll('[data-edit-module]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const module = (await getAdminModules()).find(m => m.id === btn.dataset.editModule);

      const form = document.querySelector('#moduleForm');

      form.moduleId.value = module.id;
      form.title.value = module.title;
      form.description.value = module.description;
      form.order.value = module.order;
      form.status.value = module.status;

      toast('Módulo carregado para edição.');
    });
  });

  target.querySelectorAll('[data-delete-module]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Excluir este módulo e suas aulas?')) return;

      const moduleId = btn.dataset.deleteModule;
      const lessons = await getModuleLessons(moduleId, true);

      const batch = db.batch();

      batch.delete(db.collection('modules').doc(moduleId));

      lessons.forEach(lesson => {
        batch.delete(db.collection('lessons').doc(lesson.id));
      });

      await batch.commit();

      await refreshAdmin();
    });
  });
}

async function renderLessonsAdmin() {
  const lessons = await getAllLessonsAdmin();
  const modules = await getAdminModules();

  const videoSelect = document.querySelector('#videoLessonId');

  if (videoSelect) {
    videoSelect.innerHTML = lessons.map(l => `
      <option value="${l.id}">${escapeHtml(l.title)}</option>
    `).join('');
  }

  const target = document.querySelector('#lessonsTable');
  if (!target) return;

  target.innerHTML = lessons.map(lesson => {
    const module = modules.find(m => m.id === lesson.moduleId);

    return `
      <tr>
        <td>${escapeHtml(module?.title || '-')}</td>

        <td>
          <strong>${escapeHtml(lesson.title)}</strong>
          <br>
          <span class="helper">${escapeHtml(lesson.description || '')}</span>
          ${
            lesson.videoName
              ? `<br><span class="helper">Vídeo: ${escapeHtml(lesson.videoName)}</span>`
              : ''
          }
        </td>

        <td>${escapeHtml(lesson.duration || '-')}</td>

        <td>
          <span class="badge ${lesson.status === 'publicado' ? 'done' : ''}">
            ${escapeHtml(lesson.status)}
          </span>
        </td>

        <td class="actions">
          <button class="btn small secondary" data-edit-lesson="${lesson.id}">Editar</button>
          <button class="btn small secondary" data-upload-video="${lesson.id}">Vídeo</button>
          <button class="btn small danger" data-delete-lesson="${lesson.id}">Excluir</button>
        </td>
      </tr>
    `;
  }).join('') || '<tr><td colspan="5">Nenhuma aula cadastrada.</td></tr>';

  target.querySelectorAll('[data-edit-lesson]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const lesson = (await getAllLessonsAdmin()).find(l => l.id === btn.dataset.editLesson);

      const form = document.querySelector('#lessonForm');

      form.lessonId.value = lesson.id;
      form.moduleId.value = lesson.moduleId;
      form.title.value = lesson.title;
      form.description.value = lesson.description;
      form.duration.value = lesson.duration;
      form.order.value = lesson.order;
      form.status.value = lesson.status;

      toast('Aula carregada para edição.');
    });
  });

  target.querySelectorAll('[data-delete-lesson]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Excluir esta aula?')) return;

      await db.collection('lessons').doc(btn.dataset.deleteLesson).delete();

      await refreshAdmin();
    });
  });

  target.querySelectorAll('[data-upload-video]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelector('#videoLessonId').value = btn.dataset.uploadVideo;
      document.querySelector('[data-tab="videosAdmin"]').click();
    });
  });
}

function setupForms() {
  const studentForm = document.querySelector('#studentForm');

  studentForm?.addEventListener('submit', async event => {
    event.preventDefault();

    const email = studentForm.email.value.trim().toLowerCase();
    const pass = studentForm.password.value || generatePassword();

    try {
      const result = await api('/api/create-user', {
        method: 'POST',
        json: {
          name: studentForm.name.value.trim(),
          email,
          phone: studentForm.phone.value.trim(),
          password: pass
        }
      });

      studentForm.reset();

      await renderStudents();
      await renderAdminDashboard();

      copyText(`Acesso ao curso Beta\nLink: ${location.origin}/login.html\nE-mail: ${email}\nSenha: ${result.password || pass}`);

      toast('Aluno cadastrado. Dados copiados.');
    } catch (err) {
      toast(err.message);
    }
  });

  document.querySelector('#generatePass')?.addEventListener('click', () => {
    document.querySelector('#studentPassword').value = generatePassword();
  });

  const moduleForm = document.querySelector('#moduleForm');

  moduleForm?.addEventListener('submit', async event => {
    event.preventDefault();

    const payload = {
      title: moduleForm.title.value.trim(),
      description: moduleForm.description.value.trim(),
      order: Number(moduleForm.order.value || 1),
      status: moduleForm.status.value,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    if (moduleForm.moduleId.value) {
      await db.collection('modules').doc(moduleForm.moduleId.value).set(payload, { merge: true });
    } else {
      await db.collection('modules').add({
        ...payload,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }

    moduleForm.reset();
    moduleForm.moduleId.value = '';

    await refreshAdmin();

    toast('Módulo salvo.');
  });

  document.querySelector('#clearModuleForm')?.addEventListener('click', () => {
    moduleForm.reset();
    moduleForm.moduleId.value = '';
  });

  const lessonForm = document.querySelector('#lessonForm');

  lessonForm?.addEventListener('submit', async event => {
    event.preventDefault();

    const old = lessonForm.lessonId.value
      ? (await db.collection('lessons').doc(lessonForm.lessonId.value).get()).data() || {}
      : {};

    const payload = {
      ...old,
      moduleId: lessonForm.moduleId.value,
      title: lessonForm.title.value.trim(),
      description: lessonForm.description.value.trim(),
      duration: lessonForm.duration.value.trim(),
      order: Number(lessonForm.order.value || 1),
      status: lessonForm.status.value,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    if (lessonForm.lessonId.value) {
      await db.collection('lessons').doc(lessonForm.lessonId.value).set(payload, { merge: true });
    } else {
      await db.collection('lessons').add({
        ...payload,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }

    lessonForm.reset();
    lessonForm.lessonId.value = '';

    await refreshAdmin();

    toast('Aula salva.');
  });

  document.querySelector('#clearLessonForm')?.addEventListener('click', () => {
    lessonForm.reset();
    lessonForm.lessonId.value = '';
  });

  const videoForm = document.querySelector('#videoForm');

  videoForm?.addEventListener('submit', async event => {
    event.preventDefault();

    const lessonId = videoForm.lessonId.value;
    const file = videoForm.video.files[0];

    if (!lessonId || !file) {
      return toast('Selecione uma aula e um arquivo de vídeo.');
    }

    const submit = videoForm.querySelector('button[type="submit"]');

    submit.disabled = true;
    submit.textContent = 'Enviando vídeo...';

    try {
      const token = await getIdToken(true);

      const safeName = file.name
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/-+/g, '-');

      const { upload } = await import('https://esm.sh/@vercel/blob@latest/client');

      const blob = await upload(`videos/${lessonId}/${Date.now()}-${safeName}`, file, {
        access: 'public',
        handleUploadUrl: '/api/blob-upload',
        multipart: true,
        clientPayload: JSON.stringify({
          idToken: token,
          lessonId
        })
      });

      await db.collection('lessons').doc(lessonId).set({
        videoUrl: blob.url,
        videoPath: blob.pathname || blob.url,
        videoName: file.name,
        hasVideo: true,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      videoForm.reset();

      await renderLessonsAdmin();

      toast('Vídeo enviado e vinculado à aula.');
    } catch (err) {
      toast(err.message || 'Não foi possível enviar o vídeo.');
    }

    submit.disabled = false;
    submit.textContent = 'Salvar vídeo';
  });

  document.querySelector('#exportData')?.addEventListener('click', async () => {
    const [users, modules, lessons, progress] = await Promise.all([
      db.collection('users').get(),
      db.collection('modules').get(),
      db.collection('lessons').get(),
      db.collection('progress').get()
    ]);

    const data = {
      users: users.docs.map(docWithId),
      modules: modules.docs.map(docWithId),
      lessons: lessons.docs.map(docWithId),
      progress: progress.docs.map(docWithId),
      exportedAt: new Date().toISOString()
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json'
    });

    const a = document.createElement('a');

    a.href = URL.createObjectURL(blob);
    a.download = `backup-beta-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  });

  document.querySelector('#importData')?.addEventListener('change', event => {
    toast('Para a versão online, importe dados pelo console do Firebase ou solicite uma rotina de importação segura.');
    event.target.value = '';
  });

  const passwordForm = document.querySelector('#adminPasswordForm');

  passwordForm?.addEventListener('submit', async event => {
    event.preventDefault();

    if (passwordForm.newPassword.value !== passwordForm.confirmPassword.value) {
      return toast('A confirmação da senha não confere.');
    }

    try {
      const user = auth.currentUser;

      const credential = firebase.auth.EmailAuthProvider.credential(
        user.email,
        passwordForm.currentPassword.value
      );

      await user.reauthenticateWithCredential(credential);
      await user.updatePassword(passwordForm.newPassword.value);

      passwordForm.reset();

      toast('Senha do administrador alterada.');
    } catch (err) {
      toast(err.message || 'Não foi possível alterar a senha.');
    }
  });
}

function initBetaUxEnhancements() {
  insertBetaPhraseCarousel();
  setupRevealUpCards();
}

function insertBetaPhraseCarousel() {
  if (document.querySelector('.beta-phrase-carousel')) return;

  const topbar = document.querySelector('.topbar');
  if (!topbar) return;

  const phrases = [
    'Impactar pra transformar.',
    'Conectar pra avançar.',
    'Nosso vínculo cria um lugar único.',
    'Uma igreja bíblica, contemporânea e impactante.'
  ];

  const carousel = document.createElement('section');

  carousel.className = 'beta-phrase-carousel';
  carousel.setAttribute('aria-label', 'Frases da Igreja Beta');

  const repeated = [...phrases, ...phrases, ...phrases]
    .map(phrase => `<span>${escapeHtml(phrase)}</span>`)
    .join('');

  carousel.innerHTML = `<div class="beta-phrase-track">${repeated}</div>`;

  topbar.insertAdjacentElement('afterend', carousel);
}

function setupRevealUpCards() {
  const selector = '.card, .meta-card, .panel, .step, .module-card, .auth-card, .visual-card';
  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const items = () => Array.from(document.querySelectorAll(selector));

  if (reducedMotion || !('IntersectionObserver' in window)) {
    items().forEach(el => el.classList.add('is-visible'));
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;

      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    });
  }, {
    threshold: 0.35,
    rootMargin: '0px 0px -120px 0px'
  });

  const prepare = () => {
    items().forEach((el, index) => {
      if (el.dataset.revealPrepared === 'true') return;

      el.dataset.revealPrepared = 'true';
      el.classList.add('reveal-up');
      el.style.transitionDelay = `${Math.min((index % 6) * 120, 600)}ms`;

      observer.observe(el);
    });
  };

  prepare();

  const mutationObserver = new MutationObserver(() => prepare());

  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  await initLoginPage();

  if (document.body.dataset.page === 'platform') {
    await initPlatformPage();
  }

  if (document.body.dataset.page === 'lesson') {
    await initLessonPage();
  }

  if (document.body.dataset.page === 'admin') {
    await initAdminPage();
  }

  initBetaUxEnhancements();
});
