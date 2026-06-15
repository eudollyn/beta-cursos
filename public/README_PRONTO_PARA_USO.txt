PLATAFORMA BETA CURSOS - VERSÃO PRONTA PARA USO
=================================================

Esta versão não usa Node.js e não usa npm.
Ela roda com HTML, CSS, JavaScript e um servidor local em Python com banco SQLite.

O que já funciona:
- Site público com páginas: Início, Sobre, Como funciona e Acesso.
- Login fechado para alunos e admin.
- Admin cadastra alunos e gera senha.
- Admin cria módulos e aulas.
- Admin sobe vídeo direto pelo painel.
- Vídeos ficam salvos no PC servidor em storage/videos.
- Dados ficam salvos no banco local data/beta.db.
- Alunos assistem aos vídeos pelo player da plataforma.
- Progresso de aula fica salvo por aluno.
- Admin pode bloquear aluno, gerar nova senha e acompanhar progresso.
- Backup JSON dos dados.
- Preparado para Cloudflare Tunnel.

COMO INICIAR
============

1) Extraia a pasta em um local fixo, por exemplo:
C:\beta-cursos

2) Instale o Python, caso ainda não tenha:
https://www.python.org/downloads/

Durante a instalação, marque a opção:
Add python.exe to PATH

3) Clique duas vezes em:
INICIAR_SITE.bat

4) Acesse no navegador:
http://localhost:3000

Admin:
http://localhost:3000/admin.html

ACESSO INICIAL
==============

Admin:
E-mail: admin@beta.com.br
Senha: BetaAdmin2026

Aluno teste:
E-mail: aluno@beta.com.br
Senha: Beta2026

IMPORTANTE: depois do primeiro acesso, entre no Admin > Segurança e troque a senha do admin.

CLOUDFLARE TUNNEL
=================

Com o site aberto em localhost:3000, rode em outro terminal:
cloudflared tunnel --url http://localhost:3000

Para domínio fixo, crie um Tunnel no painel da Cloudflare Zero Trust e aponte o serviço para:
http://localhost:3000

BACKUP COMPLETO
===============

Copie estas pastas:
data
storage

O backup JSON do painel salva os dados, mas os arquivos de vídeo ficam fisicamente em storage/videos.

OBSERVAÇÕES
===========

- O PC servidor precisa ficar ligado.
- A internet precisa ficar ativa.
- O arquivo INICIAR_SITE.bat precisa continuar aberto.
- Para vídeos grandes, envie pelo admin usando http://localhost:3000/admin.html no próprio PC servidor.
- Senhas são armazenadas com hash no SQLite.
