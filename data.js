// ============================================================
// BETA CURSOS — DATA LAYER
// All course content, quiz questions, and configuration live here.
// Replace mock data with real content from the CMS/admin panel.
// ============================================================

// QUIZ CONFIGURATION (configurable per course/module/lesson)
const QUIZ_CONFIG = {
  questionsPerLesson: 5,
  optionsPerQuestion: 4,
  passingScore: 4,
  maxAttempts: 3,              // Consecutive attempts before lockout
  shuffleQuestions: true,
  shuffleOptions: true,
};

// PRICING CONFIGURATION
const PRICING_CONFIG = {
  fullPrice: 19.90,
  memberDiscount: 0,
  currency: 'BRL',
  mode: 'production',
  installments: [1, 2, 3, 6, 12],
  paymentMethods: ['credit_card', 'pix', 'boleto'],
};

// COURSE DATA
const COURSES_DATA = [
  {
    id: 'jornada-lidere',
    slug: 'jornada-lidere',
    status: 'published',
    featured: true,
    version: 1,
    revision: 1,
    createdAt: '2026-06-01T12:00:00.000Z',
    updatedAt: '2026-07-13T12:00:00.000Z',
    publishedAt: '2026-07-13T12:00:00.000Z',
    title: 'Jornada Lidere',
    subtitle: 'Formação de Líderes — Módulo 1',
    description: 'A Jornada Lidere é o programa de formação de líderes da Igreja Beta. Ao longo de 6 lições práticas e profundas, você será equipado para liderar com propósito, integridade e impacto. Esta é a base da sua jornada de liderança.',
    coverImage: null,
    contentStatus: 'demo',
    duration: '6 lições',
    level: 'Iniciante',
    category: 'Engajar',
    quizConfig: {
      passingScore: 4,
      maxAttempts: 3,
      shuffleQuestions: true,
      shuffleOptions: true,
    },
    pricing: {
      fullPrice: 19.90,
      memberDiscount: 0,
      currency: 'BRL',
      mode: 'production',
      installments: [1, 2, 3, 6, 12],
      paymentMethods: ['credit_card', 'pix', 'boleto'],
    },
    modules: [
      {
        id: 'modulo-1',
        title: 'Módulo 1 — Fundamentos da Liderança',
        order: 1,
        description: 'Os pilares que sustentam toda liderança genuína.',
        lessons: [
          {
            id: 'licao-1',
            order: 1,
            title: 'Lição 1 — O Chamado do Líder',
            description: 'Entendendo o chamado e a responsabilidade de liderar.',
            pdfUrl: 'assets/apostila-demo.pdf',
            pdfTitle: 'Apostila — Lição 1: O Chamado do Líder',
            videoProvider: 'youtube',  // 'youtube' | 'vimeo' | 's3' | 'direct'
            videoEmbedId: null,
            videoTitle: 'Aula 1 — O Chamado do Líder',
            quiz: generatePlaceholderQuiz('licao-1', 1),
          },
          {
            id: 'licao-2',
            order: 2,
            title: 'Lição 2 — Identidade e Caráter',
            description: 'A liderança começa de dentro para fora.',
            pdfUrl: 'assets/apostila-demo.pdf',
            pdfTitle: 'Apostila — Lição 2: Identidade e Caráter',
            videoProvider: 'youtube',
            videoEmbedId: null,
            videoTitle: 'Aula 2 — Identidade e Caráter',
            quiz: generatePlaceholderQuiz('licao-2', 2),
          },
          {
            id: 'licao-3',
            order: 3,
            title: 'Lição 3 — Visão e Propósito',
            description: 'Como cultivar e comunicar uma visão transformadora.',
            pdfUrl: 'assets/apostila-demo.pdf',
            pdfTitle: 'Apostila — Lição 3: Visão e Propósito',
            videoProvider: 'youtube',
            videoEmbedId: null,
            videoTitle: 'Aula 3 — Visão e Propósito',
            quiz: generatePlaceholderQuiz('licao-3', 3),
          },
          {
            id: 'licao-4',
            order: 4,
            title: 'Lição 4 — Servindo e Influenciando',
            description: 'A liderança servidora como modelo transformador.',
            pdfUrl: 'assets/apostila-demo.pdf',
            pdfTitle: 'Apostila — Lição 4: Servindo e Influenciando',
            videoProvider: 'youtube',
            videoEmbedId: null,
            videoTitle: 'Aula 4 — Servindo e Influenciando',
            quiz: generatePlaceholderQuiz('licao-4', 4),
          },
          {
            id: 'licao-5',
            order: 5,
            title: 'Lição 5 — Relacionamentos e Equipe',
            description: 'Construindo relações saudáveis e times de alta performance.',
            pdfUrl: 'assets/apostila-demo.pdf',
            pdfTitle: 'Apostila — Lição 5: Relacionamentos e Equipe',
            videoProvider: 'youtube',
            videoEmbedId: null,
            videoTitle: 'Aula 5 — Relacionamentos e Equipe',
            quiz: generatePlaceholderQuiz('licao-5', 5),
          },
          {
            id: 'licao-6',
            order: 6,
            title: 'Lição 6 — Legado e Missão',
            description: 'Deixando um impacto duradouro através da liderança.',
            pdfUrl: 'assets/apostila-demo.pdf',
            pdfTitle: 'Apostila — Lição 6: Legado e Missão',
            videoProvider: 'youtube',
            videoEmbedId: null,
            videoTitle: 'Aula 6 — Legado e Missão',
            quiz: generatePlaceholderQuiz('licao-6', 6),
          },
        ],
      },
    ],
  },
];

// ============================================================
// DEMONSTRATION QUIZ GENERATOR
// These questions validate the product flow only. Replace them with the
// pastoral team's approved lesson questions before opening paid enrollment.
// ============================================================
function generatePlaceholderQuiz(lessonId, lessonNumber) {
  const templates = [
    {
      question: `Nesta demonstração da Lição ${lessonNumber}, qual etapa vem logo depois da leitura da apostila?`,
      options: [
        { id: 'a', text: 'Assistir à aula em vídeo' },
        { id: 'b', text: 'Pular para a próxima lição' },
        { id: 'c', text: 'Emitir um certificado' },
        { id: 'd', text: 'Abrir o painel do facilitador' },
      ],
      correctOptionId: 'a',
      explanation: 'A jornada segue a ordem apostila, vídeo e teste.',
    },
    {
      question: 'O que libera a próxima lição da jornada?',
      options: [
        { id: 'a', text: 'Somente abrir a apostila' },
        { id: 'b', text: 'Ser aprovado no teste da lição atual' },
        { id: 'c', text: 'Esperar 24 horas' },
        { id: 'd', text: 'Solicitar ao facilitador' },
      ],
      correctOptionId: 'b',
      explanation: 'A aprovação no teste conclui a lição e libera a seguinte.',
    },
    {
      question: 'Quantas tentativas existem em cada rodada do teste?',
      options: [
        { id: 'a', text: 'Uma tentativa' },
        { id: 'b', text: 'Duas tentativas' },
        { id: 'c', text: 'Três tentativas' },
        { id: 'd', text: 'Tentativas ilimitadas' },
      ],
      correctOptionId: 'c',
      explanation: 'O curso usa três tentativas consecutivas antes da revisão obrigatória.',
    },
    {
      question: 'O que acontece quando todas as tentativas são usadas sem aprovação?',
      options: [
        { id: 'a', text: 'O curso é cancelado' },
        { id: 'b', text: 'A próxima lição é liberada mesmo assim' },
        { id: 'c', text: 'A nota é apagada sem nenhuma ação' },
        { id: 'd', text: 'A apostila e o vídeo precisam ser revisados' },
      ],
      correctOptionId: 'd',
      explanation: 'A revisão dos dois materiais abre uma nova rodada de tentativas.',
    },
    {
      question: 'Onde o aluno acompanha lições concluídas e a etapa atual?',
      options: [
        { id: 'a', text: 'No painel do aluno' },
        { id: 'b', text: 'Somente por e-mail' },
        { id: 'c', text: 'No checkout' },
        { id: 'd', text: 'No site do Mercado Pago' },
      ],
      correctOptionId: 'a',
      explanation: 'O painel resume matrícula, progresso e o próximo passo da jornada.',
    },
  ];

  return templates.slice(0, QUIZ_CONFIG.questionsPerLesson).map((question, index) => ({
    id: `${lessonId}-q${index + 1}`,
    ...question,
  }));
}

// MOCK ADMIN DATA
const MOCK_STUDENTS = [
  {
    id: 'student-001',
    name: 'Maria Silva',
    email: 'maria@exemplo.com',
    memberCode: 'Beta0042',
    enrolledAt: '2026-05-10',
    lastAccess: '2026-06-17',
    progress: { 'jornada-lidere': { completedLessons: 4, currentLesson: 'licao-5', percentage: 67 } },
  },
  {
    id: 'student-002',
    name: 'João Santos',
    email: 'joao@exemplo.com',
    memberCode: 'Beta0087',
    enrolledAt: '2026-05-12',
    lastAccess: '2026-06-16',
    progress: { 'jornada-lidere': { completedLessons: 6, currentLesson: null, percentage: 100 } },
  },
  {
    id: 'student-003',
    name: 'Ana Costa',
    email: 'ana@exemplo.com',
    memberCode: null,
    enrolledAt: '2026-05-20',
    lastAccess: '2026-06-14',
    progress: { 'jornada-lidere': { completedLessons: 2, currentLesson: 'licao-3', percentage: 33 } },
  },
  {
    id: 'student-004',
    name: 'Pedro Oliveira',
    email: 'pedro@exemplo.com',
    memberCode: 'Beta0115',
    enrolledAt: '2026-06-01',
    lastAccess: '2026-06-15',
    progress: { 'jornada-lidere': { completedLessons: 1, currentLesson: 'licao-2', percentage: 17 } },
  },
  {
    id: 'student-005',
    name: 'Carla Mendes',
    email: 'carla@exemplo.com',
    memberCode: 'Beta0203',
    enrolledAt: '2026-06-05',
    lastAccess: '2026-06-10',
    progress: { 'jornada-lidere': { completedLessons: 0, currentLesson: 'licao-1', percentage: 0 } },
  },
];

window.BetaAdminStudents = {
  source: 'demo',
  list() {
    return typeof structuredClone === 'function'
      ? structuredClone(MOCK_STUDENTS)
      : JSON.parse(JSON.stringify(MOCK_STUDENTS));
  },
};
