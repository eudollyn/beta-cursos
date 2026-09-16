# Hospedagem do Beta Cursos na AWS

Este documento explica, em linguagem direta, como colocar o Beta Cursos na AWS
sem limitar o projeto a uma simples página hospedada no S3. Ele é um guia de
decisão e implantação. Nenhum recurso AWS foi criado ainda.

## Resumo executivo

O Amazon S3 é adequado para guardar os arquivos do site, capas, apostilas e
vídeos enviados pela administração. Porém, o S3 sozinho não é um sistema de
cursos: ele não controla usuários, matrículas, progresso, testes, permissões ou
alterações simultâneas.

A arquitetura recomendada é:

1. **S3 + CloudFront** para entregar o site e os arquivos com HTTPS.
2. **Cognito** para login e identificação de alunos e administradores.
3. **API Gateway + Lambda** para executar as regras do sistema.
4. **DynamoDB** para salvar cursos, alunos, matrículas, progresso e resultados.
5. **URLs pré-assinadas do S3** para importar arquivos sem expor senhas ou
   chaves da AWS no navegador.

Essa combinação não exige manter um servidor tradicional ligado continuamente.
Os serviços são gerenciados pela AWS e podem começar pequenos, aumentando de
capacidade conforme o uso.

## O que o S3 hospeda

O S3 pode guardar:

- os arquivos públicos do site: HTML, CSS, JavaScript, ícones e imagem de
  compartilhamento;
- capas e imagens dos cursos;
- apostilas em PDF;
- vídeos enviados diretamente pela administração;
- arquivos de exportação e cópias de segurança, se for definida uma política
  específica para isso.

O recomendado é manter os buckets privados e permitir a entrega pelo
CloudFront. Assim o domínio usa HTTPS, os arquivos são carregados com mais
rapidez e o S3 não precisa ficar aberto diretamente na internet. A própria AWS
recomenda CloudFront com controle de acesso à origem para um site estático
seguro: [site estático seguro com S3 e CloudFront](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/getting-started-secure-static-website-cloudformation-template.html).

Vídeos do YouTube não são copiados para o S3. O sistema salva apenas o link ou
identificador do vídeo. Vídeos importados pelo painel, por outro lado, ficam no
S3 e são entregues pelo CloudFront.

## Por que o S3 sozinho não salva cursos e alunos

O S3 é um armazenamento de arquivos. Ele não substitui um banco de dados nem o
servidor da aplicação.

Se fosse usado sozinho:

- cada alteração de curso exigiria regravar um arquivo inteiro;
- dois administradores poderiam sobrescrever o trabalho um do outro;
- seria difícil pesquisar alunos, matrículas ou cursos por status;
- não haveria uma forma segura de validar quem pode publicar ou excluir;
- progresso, tentativas e notas não teriam atualização confiável;
- seria necessário colocar credenciais da AWS no navegador, o que é inseguro;
- não existiria uma camada para aplicar regras como “somente rascunho pode ser
  excluído” ou “uma lição publicada precisa de apostila, vídeo e cinco
  questões”.

O navegador também não deve ser a fonte oficial dos dados. Informações salvas
apenas no dispositivo não acompanham o aluno em outro celular ou computador e
podem ser apagadas facilmente.

## Arquitetura serverless recomendada

### 1. Site e arquivos — S3 + CloudFront

Um bucket privado guarda o site. Outro bucket, também privado, pode guardar as
mídias dos cursos. O CloudFront entrega ambos com HTTPS e cache.

É melhor separar site e mídia porque as regras são diferentes: o site pode ter
cache mais longo, enquanto apostilas e vídeos podem exigir autorização de
aluno matriculado. O acesso direto público ao bucket deve permanecer bloqueado.

### 2. Login — Amazon Cognito

O Cognito mantém as contas e sessões. Grupos podem separar, por exemplo:

- `owner`: responsável principal pela plataforma;
- `admin`: equipe autorizada a administrar cursos;
- `aluno`: pessoa matriculada nos cursos.

O Cognito emite uma identificação temporária que a API valida a cada ação. Ele
é um diretório de usuários e serviço de autenticação para aplicações web:
[visão geral do Amazon Cognito](https://docs.aws.amazon.com/cognito/latest/developerguide/what-is-amazon-cognito.html).

### 3. Entrada da API — API Gateway

O site chama endereços como “listar cursos”, “salvar curso”, “registrar
progresso” ou “pedir autorização para upload”. O API Gateway recebe essas
solicitações, verifica a autenticação e as encaminha para a função correta.

Ele é a porta de entrada segura da aplicação:
[visão geral do API Gateway](https://docs.aws.amazon.com/apigateway/latest/developerguide/welcome.html).

### 4. Regras — AWS Lambda

As funções Lambda executam as regras que já existem no Beta Cursos, como:

- validar módulos, lições, questões e alternativas;
- publicar, arquivar ou excluir um curso;
- impedir alterações com revisão antiga;
- conferir se o usuário é administrador;
- registrar matrícula, progresso, tentativas e aprovação;
- gerar autorização temporária para importar uma imagem, PDF ou vídeo.

API Gateway, Lambda e DynamoDB podem trabalhar juntos sem um servidor fixo. A
AWS mantém um tutorial oficial com esse fluxo:
[API Gateway + Lambda + DynamoDB](https://docs.aws.amazon.com/lambda/latest/dg/services-apigateway-tutorial.html).

### 5. Dados — DynamoDB

O DynamoDB salva os registros estruturados, por exemplo:

- cursos, módulos, lições e testes;
- usuários e seus papéis no Beta Cursos;
- matrículas;
- progresso por lição;
- tentativas e resultados dos testes;
- metadados dos arquivos do S3;
- histórico básico das ações administrativas.

Os arquivos grandes não ficam no DynamoDB; ficam no S3. O banco guarda somente
dados pesquisáveis e a referência segura do arquivo. O DynamoDB é um banco
gerenciado e serverless:
[visão geral do DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Introduction.html).

### 6. Importação de arquivos — URL pré-assinada

Para importar uma capa, apostila ou vídeo:

1. o painel pede uma autorização de upload à API;
2. a Lambda confirma que o usuário é administrador, valida nome, tipo e tamanho
   e gera uma URL com prazo curto;
3. o navegador envia o arquivo diretamente ao S3 usando essa URL;
4. o painel confirma o envio e a API registra os metadados no DynamoDB.

Assim a chave da AWS nunca é entregue ao navegador e um vídeo grande não
precisa atravessar a Lambda. A AWS documenta o uso dessas autorizações
temporárias em [uploads e downloads com URLs pré-assinadas](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html).

## Checklist para a equipe da igreja

### Decisões de negócio

- [ ] Qual será o domínio oficial do Beta Cursos?
- [ ] A conta AWS já existe? Quem responde por cobrança e segurança?
- [ ] Qual orçamento mensal inicial foi aprovado?
- [ ] Quantos alunos são esperados no primeiro ano?
- [ ] Qual o tamanho médio e máximo dos vídeos?
- [ ] Vídeos ficarão no YouTube, no S3 ou nos dois?
- [ ] O cadastro será aberto ou os alunos serão criados/convidados pela igreja?
- [ ] Quais papéis existirão: proprietário, administrador, facilitador e aluno?
- [ ] Quem pode publicar, arquivar, excluir e consultar dados de alunos?
- [ ] O código de membro continuará existindo? Quem valida esse código?
- [ ] O pagamento será integrado agora ou em uma segunda etapa?
- [ ] Por quanto tempo progresso, notas e registros de acesso devem ser mantidos?
- [ ] Quem aprova o tratamento de dados pessoais conforme a política da igreja e
  a LGPD?
- [ ] Qual região AWS será usada? A decisão deve considerar custo, suporte e a
  localização dos dados.

### Informações necessárias

- [ ] ID da conta AWS, sem enviar senha.
- [ ] Região AWS aprovada.
- [ ] Domínio e acesso à configuração DNS, se houver domínio próprio.
- [ ] Nome e contato do responsável pela conta e faturamento.
- [ ] Lista inicial de proprietários e administradores, com e-mails corretos.
- [ ] Política de senha e necessidade de autenticação em dois fatores.
- [ ] Conteúdo oficial do primeiro curso: capas, PDFs, vídeos e questões.
- [ ] Estimativa de alunos, acessos e armazenamento para configurar alertas de
  custo.
- [ ] Decisão sobre ambientes separados de teste e produção.
- [ ] Processo aprovado para backup, restauração e atendimento a incidentes.

### Permissões para a implantação

A equipe deve criar um acesso de trabalho separado, temporário quando possível,
com permissão somente para os recursos necessários:

- criar e configurar os buckets S3 do projeto;
- criar a distribuição CloudFront e seu acesso privado ao S3;
- configurar certificado e domínio, se isso fizer parte da entrega;
- criar API Gateway e funções Lambda;
- criar tabelas DynamoDB;
- criar o User Pool do Cognito e seus grupos;
- criar papéis IAM específicos para Lambda, implantação e leitura de logs;
- consultar logs e métricas do projeto;
- configurar alertas de custo, se autorizado.

Não é necessário compartilhar a senha principal da conta para fazer esse
trabalho.

## Segurança obrigatória

### Nunca compartilhar o usuário root

O usuário root tem controle total da conta. Sua senha, código de autenticação e
chaves de acesso não devem ser enviados por e-mail, mensagem, documento ou
repositório. A AWS recomenda usar o root apenas quando uma tarefa realmente o
exigir, ativar MFA e não criar chaves de acesso para ele:
[boas práticas para o usuário root](https://docs.aws.amazon.com/IAM/latest/UserGuide/root-user-best-practices.html).

### Dar somente a permissão necessária

Cada pessoa e serviço deve receber apenas as ações que precisa realizar. A
Lambda de cursos, por exemplo, não precisa administrar cobrança; a função de
upload não precisa alterar usuários do Cognito. A AWS chama isso de princípio
do menor privilégio:
[políticas e menor privilégio no IAM](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies.html).

Também é necessário:

- usar MFA para contas administrativas;
- preferir papéis e credenciais temporárias a chaves permanentes;
- nunca colocar chave secreta no JavaScript, no Git ou em arquivo público;
- manter o bloqueio de acesso público do S3 ativo;
- permitir que o CloudFront leia somente os buckets necessários;
- criptografar dados em trânsito com HTTPS;
- limitar URLs de upload por arquivo, tamanho, tipo e tempo;
- separar teste e produção;
- registrar ações administrativas e acompanhar erros;
- definir retenção de backups e dados pessoais;
- revisar periodicamente usuários e permissões que não são mais necessários.

## Sequência recomendada de implantação

1. **Confirmar decisões:** conta, região, domínio, responsáveis, orçamento,
   papéis de usuário e política de dados.
2. **Preparar acessos seguros:** proteger o root, ativar MFA e criar o papel de
   implantação com o mínimo de permissões.
3. **Criar os ambientes:** separar teste e produção desde o início.
4. **Criar S3 e CloudFront:** buckets privados, HTTPS, domínio e regras de cache.
5. **Configurar Cognito:** login, recuperação de senha, grupos e primeiro owner.
6. **Modelar o DynamoDB:** cursos, mídia, matrículas, progresso, tentativas e
   auditoria.
7. **Adaptar a API atual:** implementar as mesmas rotas e validações em Lambda,
   publicadas pelo API Gateway.
8. **Implantar uploads pré-assinados:** capas, PDFs e vídeos diretamente para o
   S3, com validação e expiração.
9. **Migrar o conteúdo inicial:** Jornada Lidere, materiais oficiais e perguntas
   aprovadas.
10. **Testar ponta a ponta:** administrador, publicação, aluno, progresso,
    vídeo, PDF, teste, bloqueios e restauração.
11. **Revisar segurança e custos:** permissões, logs, alertas e limites.
12. **Publicar em produção:** apontar o domínio somente após a aprovação final.

## O que já está pronto

- experiência pública e painel administrativo do Beta Cursos;
- criação, edição, duplicação, publicação e arquivamento de cursos;
- módulos, lições, questões e alternativas com IDs estáveis;
- validação de apostila, vídeo e teste antes da publicação;
- importação e biblioteca de capas, PDFs e vídeos na prévia atual;
- reprodução por upload ou links de YouTube, Vimeo e HTTPS direto;
- estados `draft`, `published` e `archived`;
- proteção contra edição simultânea por `version`/`revision`;
- exportação e restauração do catálogo;
- contrato de API definido, que pode ser mantido na migração para AWS;
- regras e testes automatizados que servem como referência para a Lambda.

## O que depende de autorização e ainda não foi implantado

- acesso seguro a uma conta AWS;
- aprovação de região, domínio, orçamento e responsáveis;
- buckets S3 e distribuição CloudFront;
- certificado HTTPS e configuração DNS;
- User Pool, grupos e políticas do Cognito;
- tabelas e índices no DynamoDB;
- API Gateway e funções Lambda;
- papéis e políticas IAM;
- fluxo de URLs pré-assinadas;
- logs, alertas de custo, backups e política de retenção;
- migração dos dados da prévia para DynamoDB/S3;
- autenticação e autorização próprias para alunos fora da prévia privada;
- testes de carga, segurança e recuperação no ambiente AWS;
- conteúdo pastoral definitivo e aprovação para abertura aos alunos.

O backend AWS não deve ser iniciado até que esses pontos tenham responsáveis e
aprovação explícita. O código atual reduz o trabalho de migração porque o
formato dos cursos e o contrato da API já estão definidos, mas os recursos AWS
e a adaptação das funções ainda precisam ser construídos no ambiente aprovado.

## Documentação oficial AWS

- [Site estático seguro com S3 e CloudFront](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/getting-started-secure-static-website-cloudformation-template.html)
- [URLs pré-assinadas do S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
- [Amazon API Gateway](https://docs.aws.amazon.com/apigateway/latest/developerguide/welcome.html)
- [Tutorial de API Gateway, Lambda e DynamoDB](https://docs.aws.amazon.com/lambda/latest/dg/services-apigateway-tutorial.html)
- [Amazon DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Introduction.html)
- [Amazon Cognito](https://docs.aws.amazon.com/cognito/latest/developerguide/what-is-amazon-cognito.html)
- [Boas práticas para o usuário root](https://docs.aws.amazon.com/IAM/latest/UserGuide/root-user-best-practices.html)
- [Menor privilégio no IAM](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies.html)
