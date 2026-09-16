# Proposta para a Jornada Beta, fases e liberação de cursos

> Status: proposta para alinhamento com o Pr. Fernando. Nenhuma regra de fase foi ativada nesta entrega.

## Decisão já alinhada

A relação entre curso, trilha, fase e pré-requisitos será definida no lançamento de cada formação, porque o catálogo ainda será construído ao longo do tempo. Portanto:

- não haverá uma lista inicial obrigatória relacionando todos os cursos às fases;
- um curso novo poderá permanecer **sem fase definida** enquanto estiver sendo preparado;
- fase e pré-requisitos serão configurados no próprio curso quando a liderança aprovar seu lançamento;
- atribuir ou alterar essa organização depois não poderá apagar matrículas, conclusões ou progresso já registrado.

## Recomendação principal

O Beta Cursos deve consultar uma única origem para saber a fase atual do aluno:

- agora, enquanto o CRM não existe, a fase é atribuída manualmente no Beta Cursos;
- depois, o CRM pastoral passa a ser a fonte oficial e o painel Beta exibe esse dado somente para leitura;
- o Beta pode manter uma cópia sincronizada para desempenho, identificada como cópia do CRM, com versão e data da última sincronização. Essa cópia nunca será uma segunda fonte editável.

Essa separação evita que o site e o futuro CRM discordem sobre a mesma pessoa.

## Responsabilidade por cada informação

| Informação | Responsável agora | Responsável depois |
| --- | --- | --- |
| Fase pastoral do aluno | Beta Cursos, por atribuição manual e auditada | CRM pastoral |
| Fase e política de acesso de cada curso | Beta Cursos | Beta Cursos |
| Matrícula, progresso, testes e conclusão | Beta Cursos | Beta Cursos |
| Conteúdo, apostilas, vídeos e questões | Beta Cursos | Beta Cursos |
| Histórico de alterações | Beta Cursos | Beta Cursos e eventos recebidos do CRM |

Concluir um curso não deve mudar automaticamente a fase pastoral. O Beta registra a conclusão e emite um evento; o responsável pastoral ou o CRM decide se isso provoca avanço.

## Estrutura recomendada para cada curso

Cada curso poderá usar os identificadores estáveis `atrair`, `adorar`, `relacionar`, `discipular` e `engajar`:

```json
{
  "journeyPhaseId": "discipular",
  "accessPolicy": {
    "mode": "restricted",
    "minimumPhaseId": "discipular",
    "prerequisiteCourseIds": ["fundamentos-da-fe"],
    "prerequisiteMode": "all",
    "catalogVisibility": "show_locked"
  }
}
```

A fase que organiza o curso e a fase mínima para acesso devem ser campos separados. Os pré-requisitos devem usar os identificadores imutáveis dos cursos, com validação para impedir referência ao próprio curso e dependências circulares.

## Regra de liberação

A decisão precisa acontecer no servidor, e não apenas escondendo botões na tela:

1. O curso precisa estar publicado.
2. Curso aberto pode receber inscrição.
3. Uma liberação pastoral excepcional pode permitir o acesso sem alterar a fase do aluno.
4. Curso restrito exige fase conhecida, fase mínima alcançada e pré-requisitos concluídos.
5. Depois disso, são conferidas matrícula e eventual contribuição.
6. Somente então o servidor entrega aulas, apostilas, vídeos e testes.

O sistema deve informar o motivo de um bloqueio para apresentar uma orientação clara, por exemplo: fase ainda não definida, etapa mínima não alcançada, curso anterior pendente, matrícula ausente ou contribuição pendente.

## Mudanças futuras no painel administrativo

- seção **Jornada e acesso** no cadastro do curso;
- seleção da fase, curso aberto/restrito, fase mínima e pré-requisitos;
- aviso automático para regras inválidas ou circulares;
- filtros por fase e modalidade de acesso;
- na tela de alunos: fase, origem do dado e última sincronização;
- alteração manual com responsável e motivo enquanto o modo manual estiver ativo;
- campo somente para leitura quando o CRM assumir;
- liberação excepcional por curso com motivo e prazo;
- explicação de por que um aluno está bloqueado.

Também será necessário definir o papel do **facilitador**, incluindo quem pode mudar fases e conceder exceções.

## Transição do modo manual para o CRM

1. Usar desde o início os cinco identificadores estáveis de fase.
2. Registrar toda alteração manual com responsável, data, motivo e versão.
3. Quando o CRM estiver pronto, suspender temporariamente as mudanças de fase no Beta.
4. Relacionar o identificador interno do aluno ao identificador da pessoa no CRM; o e-mail não deve ser a chave principal.
5. Importar e reconciliar as fases no CRM.
6. Sincronizar o CRM de volta para a cópia de consulta do Beta Cursos.
7. Ativar globalmente o modo `crm`.
8. A partir daí, o Beta Cursos recusa alterações locais de fase e recebe atualizações assinadas e repetíveis do CRM.

## Preparação possível antes do CRM

- cadastrar as cinco fases e seus identificadores;
- preparar o formato das regras de curso;
- criar o motor de decisão e os motivos de bloqueio;
- criar a atribuição manual auditada;
- criar liberações excepcionais sem mudar a fase;
- validar pré-requisitos e dependências circulares;
- separar o catálogo público do conteúdo protegido;
- preparar a interface que troca a origem manual pela origem CRM;
- cobrir as combinações de acesso com testes automatizados.

## Decisões necessárias antes da implementação

1. No lançamento de cada curso, qual será sua trilha, fase, classificação e lista de pré-requisitos?
2. Cursos bloqueados aparecem no catálogo com o próximo passo ou ficam ocultos?
3. Estar em uma fase libera também todos os cursos das fases anteriores?
4. Cursos abertos exigem cadastro antes da inscrição?
5. Quem pode mudar a fase e conceder uma exceção?
6. Uma conclusão apenas recomenda o avanço ou pode efetivá-lo?
7. O que ocorre se o CRM estiver indisponível ou com informação desatualizada?
8. Qual identificador ligará a pessoa do Beta Cursos à pessoa no CRM?

## Padrão sugerido para a conversa

Até que existam decisões diferentes, a sugestão é:

- mostrar cursos bloqueados e explicar o próximo passo;
- considerar a fase informada e todas as anteriores como alcançadas;
- exigir todos os pré-requisitos configurados;
- negar cursos restritos quando a fase do aluno ainda não estiver definida;
- permitir exceção pastoral explícita e auditada sem alterar a fase.

## Observação importante antes da abertura para alunos reais

A versão Railway mantém matrícula e progresso no banco, remove os gabaritos do catálogo público e corrige as avaliações no servidor. PDFs e vídeos enviados também exigem sessão administrativa ou matrícula ativa. O alinhamento pastoral desta proposta continua necessário para definir fases, pré-requisitos e exceções antes de aplicar essas regras ao catálogo definitivo.
