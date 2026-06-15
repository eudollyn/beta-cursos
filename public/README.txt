SITE BETA CURSOS - HTML, CSS E JAVASCRIPT

Como abrir sem instalar nada:
1. Extraia o ZIP.
2. Abra o arquivo index.html no navegador.

Como rodar em localhost para usar Cloudflare Tunnel:
1. Dê dois cliques em iniciar_servidor.bat.
2. Acesse http://localhost:3000
3. Em outro terminal, rode:
   cloudflared tunnel --url http://localhost:3000

Acessos de teste:
Admin: admin@beta.com.br / BetaAdmin2026
Aluno: aluno@beta.com.br / Beta2026

Observação importante:
Esta versão é feita apenas com HTML, CSS e JavaScript, sem Node, sem npm, sem servidor backend e sem banco.
Por isso, os dados ficam salvos no navegador pelo localStorage/IndexedDB.

O que funciona neste modelo:
- Site institucional com páginas Início, Sobre, Como funciona e Acesso.
- Login fechado simulado.
- Painel admin.
- Cadastro de alunos.
- Cadastro de módulos e aulas.
- Upload local de vídeo no navegador.
- Player de aula.
- Progresso do aluno.
- Exportar/importar backup JSON dos dados.

Limitação técnica:
Como não há backend, se um admin cadastrar aluno ou subir vídeo em um navegador, esse conteúdo fica naquele navegador. Para vários alunos acessarem os mesmos vídeos e logins de computadores diferentes, será necessário backend e banco de dados em uma próxima etapa.

Identidade visual aplicada:
- Preto #1B1B1B
- Azul #3B5562
- Creme #F5E7D7
- Laranja #BF531A
- Cinza #C5CACD
- Frases: Impactar pra transformar. Conectar pra avançar. Nosso vínculo cria um lugar único.
