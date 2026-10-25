# Исследование памяти агентов и выбор механизмов для huimem

Проверено по первоисточникам 14 сентября 2026 года. Ниже — три исследовательских
препринта 2026 года и инженерная публикация Anthropic. Для этих версий статей
рецензирование не подтверждено; инженерная публикация также не является
рецензируемым экспериментом. Это ограниченная проверка основания конкретной правки,
а не систематический обзор всей литературы.

## Что установлено в источниках

| Источник и статус | Прямой результат или рекомендация | Ограничение переноса |
| --- | --- | --- |
| [Beyond Memory Leaderboards](https://arxiv.org/html/2607.16848v1), препринт. [История подачи](https://arxiv.org/abs/2607.16848): 18.07.2026; внутри HTML указано 24.08.2026. Обе даты предшествуют проверке. | Авторы сравнивают системы на восстановлении контекста научных статей. Контроль объёма выдачи меняет сравнительные результаты; рекомендуются измерения фактически возвращённых символов, явное описание бюджета, гранулярности и метода поиска (§6, §8). Сохранение деталей, необходимых для ответа, существенно; больше контекста не всегда улучшает отдельный ответ (§7.2). | Это вопросы по научным статьям, не записи нашего плагина. Бюджеты лишь приблизительно сопоставимы, синтезатор один, прогон на конфигурацию один (§8.2). Из работы не следует оптимальность конкретного алгоритма упаковки. |
| [ContextBench](https://arxiv.org/html/2602.05892v3), препринт. [История версий](https://arxiv.org/abs/2602.05892): 05.02.2026, v3 от 11.02.2026. | На задачах исправления репозиториев измеряются recall, precision и F1 контекста на уровне файлов, блоков и строк, а также динамика поиска. Найден разрыв между просмотренным полезным контекстом и контекстом, который агент считает нужным перед финальным патчем (§2.3, §3.4). | Найти нужные записи и правильно использовать их — разные проверки. Метрики по коду нельзя считать готовыми результатами для проектной памяти; заявленный агентом контекст также не даёт полного доступа к его внутреннему использованию информации. |
| [Agent Retrieval Bench](https://arxiv.org/html/2607.24882v1), препринт, [подан 27.07.2026](https://arxiv.org/abs/2607.24882). | Помимо Recall@k и MRR вводится Budgeted Context Yield: сколько размеченного полезного контекста попало в фиксированный бюджет после ранжирования (§3). Упаковка идёт по рангу с обрезкой последнего файла; заголовки входят в бюджет. Используется собственный детерминированный regex-токенизатор. | Это **не** проверка стратегии «пропустить слишком большую запись и продолжить». Основной BCY засчитывает даже один содержательный токен нужного файла, поэтому не измеряет полноту доказательств или понимание моделью. |
| [Anthropic: Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), инженерная статья от 29.09.2025. | Рекомендуется небольшой набор информативного контекста, сохранение критических деталей, постоянные структурированные заметки и загрузка данных по лёгким идентификаторам по мере необходимости. Слишком сильное сжатие может удалить детали, важность которых выяснится позже. | Это практические рекомендации команды разработчика, а не доказательство преимущества нашей реализации. Описанные подходы различаются по затратам; из статьи не следует необходимость второго LLM или сервера. |

## Инженерный вывод для `recallDetailed`

Предлагаемая правка локальна: раньше первая целая JSON-запись, не помещавшаяся в
остаток бюджета, останавливала выдачу всех следующих записей (`after-budget-stop`).
Кандидат пропускает такую запись и продолжает обход в прежнем порядке ранжирования.
Записи остаются целыми; одно уведомление о пропусках учитывается в том же бюджете.
Ранжирование, смысл записей, summaries и embeddings эта правка не изменяет;
для самого отбора второй LLM и отдельный сервер не нужны.

Это проверяемая инженерная гипотеза: меньшие записи после большой могут содержать
полезные сведения и поместиться в оставшееся место. Перечисленные источники
обосновывают оценку при одинаковом бюджете и проверку полезных сведений, **но не
доказывают, что skip-fit — лучший алгоритм или что ответы модели улучшатся**.
Дополнительные записи могут оказаться шумом; пропущенная запись высокого ранга
может содержать критическое ограничение. Сам факт пропуска должен быть виден
модели, а его причина и ID — доступны в диагностике, чтобы можно было уточнить
запрос или прочитать источник. Уведомление не заменяет недостающие доказательства.

В коде бюджет измеряется через JavaScript `String.length`, то есть в кодовых
единицах UTF-16. Это не токены модели и не строго число видимых символов.
Нельзя переносить токенные бюджеты статей на этот лимит по постоянному коэффициенту.

## Как проверять пользу

При одном наборе запросов, записей и одинаковых бюджетах сравнить старую и новую
упаковку. Отдельно учитывать:

- долю нужных ID, действительно попавших в выдачу, и пропущенные критические
  ограничения; включить случаи, где большая запись содержит самое важное;
- точность конечных ответов и соблюдение ограничений одной и той же основной
  моделью, отдельно от корректности отбора;
- фактическую длину выдачи, токены целевой модели и задержку; заполненность бюджета
  и количество записей сами по себе не являются метрикой качества;
- сохранность целых JSON-записей, прежний порядок выбранных записей, отсутствие
  превышения бюджета и доступность сведений о пропусках, включая малые бюджеты.

Автоматический тест «маленькая запись после большой теперь видна» подтверждает
только поведение упаковки. Доказательство улучшения ответов потребует отдельного
сравнения на задачах; приведённые публикации таких результатов для `omp-huimem`
не содержат. Этот документ не сообщает о проведённом модельном эксперименте.

## Обзор подходов сообщества к октябрю 2026

Проверка 21.10.2026. Это обзор механизмов с последующим локальным сравнением, не рейтинг
харнесов. Исходники реализации до сравнения не менялись; baseline собран из текущего
дерева, включая уже внедрённые quote/path search, один переход по связям и paging.
Прежнее ограничение сохраняется: SQLite/файлы, без второй модели, embeddings-сервиса
и фоновых model calls. «Без fine-tuning» не означает «без модельной обработки».
Даты arXiv сверены по metadata; независимая репликация результатов этих статей здесь
не выполнена. Результаты разных LoCoMo/LongMemEval и coding-протоколов не сведены в рейтинг.

### Что действительно нового предлагают источники

| Подход и доступность | Механизм и проверенное основание | Применимость и предел переноса |
|---|---|---|
| [SimpleMem](https://arxiv.org/abs/2601.02553), 05.01.2026, [методы v1 §2.1–2.3, §3.1](https://arxiv.org/html/2601.02553v1) | Атомарные самодостаточные воспоминания; dense + sparse + symbolic представления; scope зависит от запроса. В §3.1 явно указаны BM25, embeddings и метаданные. | Сохранить идею нескольких сигналов и информативности терминов. Полная реализация включает LLM и embeddings, поэтому не переносится целиком. LoCoMo F1 не доказывает улучшение coding-задач или отдельного sparse-компонента. |
| [xMemory](https://arxiv.org/abs/2602.02007), 02.02.2026, [v1 §3.2–3.3, §4.1](https://arxiv.org/html/2602.02007v1) | Messages → episodes → semantic components → themes; выбирается дополняющий набор, затем детали раскрываются при снижении неопределённости. | Проверить diversity/coverage как отдельного кандидата, не обрезая доказательства внутри записи. Полная система требует embeddings и uncertainty-оценки; для GPT-5 nano авторы используют дополнительную GPT-4.1-mini. Простое lexical MMR не является xMemory и может вытеснять разные нужные факты одной темы. |
| [TiMem](https://arxiv.org/abs/2601.02845), 06.01.2026 | Temporal Memory Tree, семантическая консолидация по временным уровням, выбор уровня детализации по сложности вопроса. | Версии и исходные эпизоды huimem уже сохраняют историю, но не строят такую иерархию. Автоматический вывод устойчивых предпочтений из событий — новая семантическая обработка, а не сортировка по дате. Не подменять это TTL или «новее значит истиннее». Результаты относятся к conversational QA. |
| [MAGMA](https://arxiv.org/abs/2601.03236), 06.01.2026 | Ортогональные semantic/temporal/causal/entity graphs; политика выбирает подходящий путь извлечения. | Явные dependsOn/links в huimem уже дают ограниченную relational-ветку. Они не являются автоматически построенным causal graph; называть существующий link доказанной причиной нельзя. Полный механизм — отдельная архитектура, не переименование нынешних связей. |
| [AgeMem](https://arxiv.org/abs/2601.01885), 05.01.2026 | Store/retrieve/update/summarize/discard встроены в политику агента; обучение progressive RL и step-wise GRPO. | Tool API само по себе не воспроизводит обученную политику. Требуется обучение основной модели, несовместимое с локальной доработкой плагина. |
| [ACE](https://arxiv.org/abs/2510.04618), 06.10.2025, [открытая реализация](https://github.com/ace-agent/ace) | Generator → Reflector → Curator; инкрементальные playbook-deltas и execution feedback вместо переписывания одной сводки. | Это предшественник 2025 года, используемый сообществом, не новая статья 2026. Версии/отдельные записи/procedure в huimem уже дают часть структуры. Автоматическое извлечение полезной процедуры из результата требует reflection/curation, а не счётчика показов. Не добавлять его скрыто под видом retrieval. |
| [Mastra Observational Memory](https://github.com/mastra-ai/mastra/blob/main/docs/src/content/en/docs/memory/observational-memory.mdx), документация указывает memory@1.1.0 | Observer и Reflector сжимают историю в observation log, поддерживая стабильный prompt-prefix. В коде конфигурации явно задаются модели и пороги. | Полезно для working-context/compaction, но это не безмодельная долговременная память. Текущая main-документация не является архивным снимком всех опций на октябрь; дата появления каждой современной опции здесь не установлена. Не переносить рекламное «zero context rot» как измеренную гарантию. |
| [MemTrace](https://arxiv.org/abs/2610.04838), 04.10.2026, [v1 §3.1–3.3, §4.1–4.3](https://arxiv.org/html/2610.04838v1) | Immutable traces + anchors; depend/verify/correct/supersede; проверка привязок к текущему коду перед восстановлением execution evidence. | Сохранять границы evidence/STALE/версий; они уже существуют. Полный MTG+RSG, результаты тестов и execution frontier в huimem отсутствуют. Их нельзя объявить реализованными через один links-hop. Авторы проверяют одну backbone-модель и два harness; опубликованные приросты не переносятся на наш плагин. |

### Проверка статьи против кода, а не доверие README

В [SimpleMem MCP/server/core/retriever.py](https://github.com/aiming-lab/SimpleMem/blob/main/MCP/server/core/retriever.py)
`_execute_searches` действительно запускает semantic и keyword каналы, а planning и
reflection вызывают LLM. Но [reference/database/vector_store.py](https://github.com/aiming-lab/SimpleMem/blob/main/MCP/reference/database/vector_store.py)
называет `keyword_search` приближением BM25: фактически это inclusion-score +2 за keyword
и +1 за substring текста. В [reference/core/hybrid_retriever.py](https://github.com/aiming-lab/SimpleMem/blob/main/MCP/reference/core/hybrid_retriever.py)
основной planning-путь вызывает semantic search. Поэтому нельзя заявить, что
скопированный reference-код автоматически даст описанный в статье трёхканальный эффект.
Эти main-файлы проверены как текущая реализация, не как immutable-снимок на дату статьи.

### Как оценивать перенос

[VibeMemBench](https://arxiv.org/abs/2609.23570), 20.09.2026, проверяет исполняемые coding-задачи:
в его протоколе 11 из 12 solver/system пар не превысили matched memory-off, хотя полезное
прошлое выполнение существовало. Это не опровержение любой памяти, а запрет считать
retrieval-score или число записей доказательством лучшего выполнения задачи.

У huimem пока нет статистической информативности терминов: три общих слова имеют
приоритет над одним отличительным именем модуля. Такой порядок также задаёт три seed
для relational-ветки, поэтому ошибка ранжирования может лишить контекст явного основания.
Это проверяемый пробел, не необходимость второй модели.

До внедрения сравниваются на одинаковых сохранённых данных:

1. текущий distinct-term coverage;
2. binary sparse relevance с corpus IDF — перенос только sparse-принципа SimpleMem;
3. тот же sparse score с lexical diversity — проверка set-selection мотива xMemory,
   **не** реализация его semantic hierarchy или uncertainty gate.

Сохраняются полные источники, pinned/required/current-work, fresh/STALE, границы бюджета,
one-hop cap и отсутствие TF-бонуса за повтор цитаты. Измеряются нужные ID/порядок,
полнота связанных оснований, отвлекающие записи и цена по UTF-16/времени отдельно.
Сначала offline-ranking comparison, затем выбранный вариант через настоящий bundle/API.
Синтетические контрольные случаи и старые SCENARIOS не являются внешним coding-бенчмарком.

### Сравнение кандидатов до изменения реализации

Временный offline-прототип использовал настоящий `MemoryStore.recallDetailed(query,0)`
для baseline-порядка (все записи active, metadata вмещаются в 200 кандидатов) и тот же
`queryTerms`/`termScore` для кандидатов. Это сравнение ранжирования, ещё не renderer,
не выполнение кодовых задач и не ответы модели.

Данные заданы до выбора: имена Kafka/OCCT/RabbitMQ/WebAssembly; для salient-entity
8/24/48 отвлекающих записей, содержащих общие export/report/format, и одна запись с
отличительным именем. Для complementary-same-topic два разных обязательных факта
одной темы и 8/24 записи про общий report. Ещё два семейства проверяют разные темы
и полное совпадение против частичного. Итого 28 случаев, одинаковые записи для методов.

| Семейство | Случаев | Baseline recall@2 | Binary IDF recall@2 | IDF + diversity recall@2 |
|---|---:|---:|---:|---:|
| Отличительное имя против общих слов | 12 | 0% | 100% | 100% |
| Два разных нужных факта одной темы | 8 | 100% | 100% | 50% |
| Две дополняющие темы | 4 | 100% | 100% | 100% |
| Полное против частичного совпадения | 4 | 100% | 100% | 100% |

Для первого семейства MRR: baseline 0.057173, IDF 1.0. Diversity здесь — прозрачный
отрицательный контроль: MMR с фиксированным λ=0.5, нормированным IDF и Jaccard совпавших
терминов. Он не настраивался после результатов и **не** воспроизводит semantic RepSel
xMemory. На втором семействе «похожесть» ошибочно вытесняет второй самостоятельный факт.
Поэтому lexical diversity, auto-dedup и обрезка свидетельств отклонены.

**Выбранный перенос:** corpus-aware sparse relevance, то есть сумма IDF различных
совпавших терминов. `IDF(t)=log(1+(N-df(t)+0.5)/(df(t)+0.5))`; N и df считаются по
последним не-retired записям. Повтор слова, повтор цитаты и старые версии не повышают
релевантность. Это классический IR-компонент, применяемый внутри современных memory
архитектур, **не новое изобретение 2026 и не полная реализация SimpleMem**.

Применяется только внутри прежних приоритетных классов и к выбору lexical seed.
Далее сохраняются coverage, свежесть, exact-word tie-break и ID; у seed при равенстве
relevance/coverage — ID. Публичный `score` остаётся числом разных терминов, не новым
числом с изменённым смыслом. При пустом запросе и одном термине прежний порядок сохраняется.
Не меняются source authority, proposed/accepted, STALE, required-share, one-hop cap,
schema, предел блока и отсутствие дополнительных моделей. Выбор ограничен проверенной
гипотезой: редкое имя должно отделять тему от общих слов, в том числе при выборе seed.

Проверка завершена: предметные failing-before/passing-after регрессии и одинаковые
14 SCENARIOS прошли через baseline/new bundle. Первые 12 сохранили прежний контракт,
два новых доставили отсутствовавший topic/basis с полными источниками. Настоящий core
воспроизвёл выбранный sparse top-2 на всех 28 корпусах прототипа.
Фактические размеры блоков, сырые артефакты и итог pipeline —
в [VALIDATION.md](VALIDATION.md).
Это проверка переноса конкретного компонента, не доказательство лучшего качества ответов.

## Первые 20 memory-пакетов Pi: исходники и решение для 0.7.0

Снимок [выдачи Pi Packages](https://pi.dev/packages?name=memory), проверка 21.10.2026.
Номера ниже сохраняют порядок исследованной выдачи, а не обозначают качество.
Для всех двадцати загружены именно опубликованные npm-архивы указанных версий,
проверен registry integrity и прочитаны entrypoints, storage/retrieval и lifecycle-код.
Ссылки ведут к upstream; текущая ветка upstream может отличаться от npm-снимка.
Сопоставимых результатов одной модели на всех двадцати системах здесь нет.

| № | Пакет и исследованная версия | Механизм в коде | Решение для huimem |
|---|---|---|---|
| 1 | [gentle-engram 0.4.2](https://github.com/Gentleman-Programming/engram/tree/main/plugin/pi) | HTTP-адаптер, автозапуск Go-сервиса, пассивные записи инструментов | Сохранить provenance и редактирование секретов до обрезки. Не брать сервер и обязательное давление «сохраняй всегда». |
| 2 | [pi-hermes-memory 0.9.10](https://github.com/chandra447/pi-hermes-memory) | Markdown, SQLite FTS5, автоматические review/flush/consolidation вызовы моделей | Взять разделение обязательной политики и релевантных фактов, локальный поисковый индекс и диагностику его отказов; убрать usage-hit writes и дополнительные модельные стадии. |
| 3 | [om-memory-system 4.28.0](https://github.com/cmdaltctr/omms) | ONNX-векторы, дополнительные summarize/profile запросы, локальный web | Взять ограниченный блок с исходными ID и запись завершённого результата. Не добавлять ONNX, web-сервис и side-channel LLM. |
| 4 | [@awebai/oats-pi 0.67.1](https://github.com/awebai/oats/tree/main/packages/pi) | STATE.md/log как resume-мост к OATS | Использовать короткий Plan/Progress/Next через существующие task/checkpoint, не вводить вторую правду о задачах. |
| 5 | [pi-blackhole 0.5.15](https://github.com/k0valik/pi-blackhole) | Observer/reflector/dropper, fork observational-memory, привязка к компактору | Сохранить адресуемые оригиналы и учёт законченных частей. Не копировать три агента и приватную интеграцию компакции. |
| 6 | [pi-observational-memory 3.1.4](https://github.com/elpapi42/pi-observational-memory) | Source-addressed observation/reflection ledger в сессиях Pi | Взять bounded projection и ID источников. Семантическое повышение делает основной агент намеренно, не фоновый observer. |
| 7 | [@pi-unipi/memory 2.20.5](https://github.com/Neuron-Mr-White/unipi/tree/main/packages/memory) | Python MemPalace через uv, durable Markdown, hash-ledger синхронизации | Взять changed-only и сохранность файлов. Не брать auto-install/update, subprocess на каждую операцию и basename как идентичность проекта. Комментарий о fallback не отражает обязательный storage.init. |
| 8 | [@llblab/pi-state-flow 0.26.4](https://github.com/llblab/pi-state-flow) | Native JSON patch state compiler, global/cwd/session, runtime-owned fingerprints | Взять отдельные scopes, hot/lazy, changed-only и контроль источников кодом. Не менять task-протокол целиком и не принимать fingerprint модели как доказательство. |
| 9 | [@agentskit/doc-bridge 2.3.0](https://github.com/AgentsKit-io/doc-bridge) | Детерминированный индекс документов/владения и drafts для promotion | Взять точные ссылки, ограниченные чтения и draft-only интерпретацию. Не брать весь RAG/MCP-платформенный слой и regex-router как семантическую истину. |
| 10 | [@bunshin-cc/bunshin 0.10.4](https://github.com/yiheinchai/bunshin/tree/main/packages/cli) | CLI общей библиотеки знаний, optional LLM-router/reflection | Взять адреса разделов, scope и proposed/accepted. Не переписывать стенограмму на каждом hook, не добавлять сетевую синхронизацию и per-tool subprocess. |
| 11 | [pi-smart-compact 10.6.2](https://github.com/alpertarhan/pi-smart-compact) | Восстановимая компакция, правки native context, локальный граф | Сохранить оригиналы до сокращения и native compaction fallback. Не вводить второй архив, многоступенчатый pipeline и приватную мутацию контекста OMP. |
| 12 | [@yandy0725/pi-memory 2.5.1](https://github.com/yandy/pi-packages/tree/main/pi-memory) | Файловые entries, замороженный MEMORY.md, model-assisted surfacing/dream | Взять компактный каталог отдельно от тела. Не брать включённый по умолчанию headless query или долгоживущий снимок, скрывающий исправления. |
| 13 | [@zosmaai/pi-llm-wiki 0.12.5](https://github.com/zosmaai/pi-llm-wiki) | Raw/Wiki/Meta, lexical default, optional vectors; ingest side-agent включён по умолчанию | Взять намеренно курируемый Wiki, ссылки на оригиналы и возможность main-agent synthesis. Не брать default background ingest, MCP-дубль и чтение всего vault. |
| 14 | [@amaster.ai/pi-memory-mem0 0.1.29](https://github.com/TGYD-helige/pi/tree/main/packages/pi-memory-mem0) | Mem0 Cloud/OSS/self-hosted adapter | Взять явную изоляцию проекта и независимые разрешения. Не брать backend, embedding/fact-extraction модели, в том числе в embedded-режиме. |
| 15 | [@henryqw/pi-memory 9.2.5](https://github.com/HenryQW/pi-harness/tree/main/extensions/pi-memory) | Малые MEMORY.md/USER.md, дополнительный reviewer на добавление | Взять атомарность пакета, конфликты и окончательный бюджет. Не брать review на каждую запись и prepare/dream. Global-only не заменяет project scope. |
| 16 | [@amaster.ai/pi-memory 0.1.29](https://github.com/TGYD-helige/pi/tree/main/packages/pi-memory) | Ограниченные глобальные Markdown-снимки, optional extractor, dream по временным/turn gates | Взять lifecycle снимка и branch boundaries. Не замораживать исправления и не добавлять background dream или regex как границу безопасности. |
| 17 | [@the-librarian/pi-extension 1.33.3](https://github.com/code-ministry-ltd/the-librarian/tree/main/integrations/pi) | Семь native proxies к удалённому /mcp и POST transcript delta | Взять явный learn/handoff и маленький primer. Не брать endpoint/token/backend; private-mode prompt marker не является запретом записи. |
| 18 | [@josephyoung/pi-openviking 0.1.20](https://github.com/josephyoung/pi-openviking) | Owner-bound OpenViking adapter, privileged Linux worker/bootstrap | Взять явное согласие на scope и различение user evidence/assistant proposal. Не брать сервер, LLM-selector и root bootstrap; обычная установка без trusted launcher намеренно dormant, Windows bootstrap не поддержан. |
| 19 | [pi-optchat 0.8.9](https://github.com/jonaslsaa/pi-optchat) | Raw log, дерево 512-byte summaries, сохранённый hysteresis view | Взять authoritative originals, производный индекс и точное раскрытие. Не брать фоновую суммаризацию листьев/родителей и fsync каждого summary-node. Upstream отдельно ограничивает лицензию recipe/prompts. |
| 20 | [pi-goosedump 0.13.0](https://gitlab.com/jarkkojs/goosedump) | Внешний native CLI: ranked find/show, provenance learn/recall, память opt-in | Взять поиск компактных ID → точное чтение и явный scope. Не вводить внешний backend и inference pipeline ради локального индекса. |

### Что объединено, а что сознательно не добавлено

- **Запись по изменению:** одинаковые retrieval receipts, уже подтверждённая проекция и
  неизменный checkpoint не вызывают повторные SQL-изменения. Новая версия, запрос,
  финальная доставка или scope остаются наблюдаемыми. Primary SQLite сохраняет WAL/FULL.
- **История:** lazy FTS5 sidecar `.memory/runtime/search.sqlite` содержит поисковые токены,
  не ещё одну копию стенограммы. Оригинал остаётся в schema-2 `state.sqlite`; после старого
  writer индекс пересверяется. Сбой индекса явно переводит поиск в полный streaming fallback,
  а не скрывает старые сообщения. Top-500 кандидатов — предел reranking, не удаления истории.
- **Контекст:** automatic mode не закрепляет каждое accepted-решение только из-за статуса;
  обязательные ID и текущая работа сохраняют приоритет, слабые разговорные совпадения
  отсекаются. Явный recall/чтение по ID доступны отдельно. Истина и STALE не кешируются по TTL.
- **Wiki/ADR:** основной агент намеренно пишет производную Markdown-страницу с точными
  версиями подтверждённых записей. Источники и hashes принадлежат runtime, смена источника
  даёт STALE, а не невидимый refresh. Страница не становится новым evidence или canonical
  документом и не повышает proposed до accepted. `/huimem learn` — обычный main-agent turn.
- **Scopes:** прежние вызовы остаются project; session связан с native ID, personal выключен
  до человеческого `/huimem personal on`. Выбранное evidence переносится явно, весь проектный
  transcript в personal не копируется. Не вводится неявный поиск по другим проектам.

[OptMem](https://github.com/VictorTaelin/OptMem) отдельно от pi-optchat: его `LOG.txt`
append-only, `TREE/` — пересобираемый кеш; `zoom` раскрывает исходники, `nap` просит
основного агента объединить узлы синхронно, **не** запускает фоновую модель. Полезно
разделение оригиналов/производных и read budget/storage budget. Обязательные note/nap на
пути работы и 280-byte память не перенесены: они дробят точные основания и добавляют
обязательные записи. Чужие prompts/recipe без подтверждённого разрешения не копировались.

[Basic Memory](https://github.com/basicmachines-co/basic-memory) — референс редактируемых
Markdown и ссылок, не причина форкать весь продукт. Здесь уже есть файловые документы,
версии и точные источники; второй независимый реестр/MCP не нужен. Поэтому Wiki остаётся
производным представлением поверх имеющегося evidence.

Отдельный tree-sitter/PageRank repo-map **не добавлен**: OMP уже предоставляет LSP,
поиск и чтение кода, а память хранит решения/источники, не вторую копию всего AST.
Git вызывается по запросу для истории пути; commit message не считается доказанной
причиной архитектурного решения. Отдельный ripgrep-демон также не нужен: native grep
работает по файлам, FTS — по сохранённым эпизодам. Это разные поверхности поиска.

[awesome-harness-engineering](https://github.com/ai-boost/awesome-harness-engineering)
использован как каталог первоисточников, не рейтинг или доказательство рекламных чисел.
В 0.7.0 нет MCP, нового сервера, embeddings, автоматического observer/reflector/dream,
семантического TTL, автоудаления принятых решений или скрытой смены модели.
Результаты реального плагина, совместимость и ограничения — в [VALIDATION.md](VALIDATION.md).

<a id="unified-cycle-080"></a>
## Единый цикл Hermes / Observational / LLM Wiki для 0.8.0

Повторный аудит **Git-исходников 22.10.2026**, не пересказ прежних README. Клоны размещены
в отдельном временном research-каталоге, вне плагина; чужие install/build-скрипты не запускались.
Проверены лицензии и закреплены commit IDs, поэтому выводы не привязаны к меняющемуся main.

| Upstream и проверенный commit | Реализованный механизм | Перенос в huimem |
|---|---|---|
| [pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory/tree/d09bc48564129b06dc4541f6aad50396524b7b60), MIT, Copyright 2025 Chandra Teja | `store/standing-instructions.ts` структурно отделяет user-authored pins от review/consolidation; `handlers/background-review.ts`, `correction-detector.ts`, `auto-consolidate.ts` запускают отдельные модельные стадии | Защищённые обязательные правила остаются существующим human-only `require`. Основной агент намеренно разбирает исправления и процедуры, обновляя прежний ID; второй policy-store и side-channel inference не добавлены. |
| [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory/tree/022da5e5554d04dfdc876ed7dac4a42c6b83dfd4), MIT, Copyright 2026 pi-observational-memory contributors | `session-ledger/progress.ts` различает source progress и provenance; `fold.ts` восстанавливает observations/reflections и tombstones; `projection.ts` ограничивает fold по исходным границам | Старейший bounded packet с оригинальными ролями/адресами, явный completion и отдельный prefix cursor. Наблюдение — прежняя versioned запись, обобщение — Wiki. Нет фоновых observer/reflector/dropper и замены штатного компактора. |
| [pi-llm-wiki](https://github.com/zosmaai/pi-llm-wiki/tree/46bd677041ba01f0298e5afc22e6a8b592f5f835), MIT, Copyright 2026 zosmaai | `source-packet.ts` отделяет raw capture от editable Wiki и metadata; `ingest-worker.ts` разделяет synthesis и deterministic persistence; `knowledge-links.ts` строит навигацию/backlinks | Оригиналы остаются в существующих episodes, а не копируются в новый vault. `wiki plan` связывает источники с актуальными страницами и пересмотром; `wiki discover` использует существующие record edges. Нет второго реестра сущностей, MCP, vectors или автоматического ingest-worker. |

### Общий контракт вместо трёх стеков

1. **Оригинал:** единственный эпизод с исходной ролью/ID; исходное проверенное file evidence
   по-прежнему доступно отдельно. Источник не повышает полномочия при переносе в пакет.
2. **Разбор:** `learn next` не пишет; token закрепляет scope, prefix и верхнюю границу.
   Пакет ограничен восемью источниками и 12000 UTF-16 единицами вместе с overlap.
   `complete` продвигает cursor только после проверки результатов либо явного осмысленного
   `nothing-durable`. Новый хвост не меняет уже выданный пакет, прерывание не считается успехом.
3. **Знание:** прежние kind/status/expectedVersion/source. Исправление — следующая версия,
   а не соседняя копия. Review receipt — факт обработки, не факт предметной области;
   он не принимает решение и не доказывает семантическую полноту.
4. **Синтез:** прежний Wiki v1 с точными версиями источников. План показывает непокрытые
   поддержанные записи, STALE-страницы, предложения и кандидатов одинакового текста.
   Backlinks выводятся из реестра; generated prose не становится новым графовым основанием.
5. **Доставка:** прежний automatic retrieval и общий бюджет 9000 UTF-16 единиц. В сравнении
   реальных bundle 0.7.0/0.8.0 на всех 14 SCENARIOS совпали ID, порядок и размеры блока,
   включая прежние явно обозначенные пропуски слишком длинного required evidence.

Новый persistent state — namespaced keys прежней `meta`, не новые primary tables,
не второй transcript и не новая schema. Actual bundles 0.6.10 и 0.7.0 прочитали новые
версии и дописали данные; после возврата в 0.8.0 сохранены coverage и pending append.
Точный CLI/модельный прогон и расходы находятся в [VALIDATION.md](VALIDATION.md#release-080).

### Что сознательно не переносится

- Три независимых store/scheduler/компактора, automatic dream/reflect/drop и retry-loop
  «ещё раз сохрани перед завершением». User-required правила уже имеют защищённый путь.
- Автоматическое принятие выводов, семантическое TTL и удаление оригиналов/старых версий.
  Даже реальная цитата подтверждает происхождение, не любую добавленную интерпретацию.
- Обязательная запись на каждый tool call, usage-hit counters и повторная запись
  неизменного acknowledgement. Main-agent review запускается явно, не каждый ход.
- Второй Raw/Wiki/Meta vault, весь upstream MCP/runtime и parser-generated entity graph.
  Сущности и связи, которых нет в проверенных записях, система не выдумывает.

Режим выбран пользователем: **Qwen ai1 — для тестов, не фоновая модель рабочего плагина**.
`/huimem learn` использует обычную основную модель OMP, её время/токены зависят от настроек
харнеса. Этот перенос не доказывает лидерство над двадцатью плагинами, идеальную выборку
фактов или покрытие всех coding/бытовых задач. Все три проекта — design references;
их движки/промпты целиком не vendored. Лицензии и атрибуция — в
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md#memory-design-references).

<a id="incremental-audit-082"></a>
## Повторный аудит Hermes и первый этап оптимизации 0.8.2

Повторный Git-аудит `pi-hermes-memory` обнаружил package version **0.9.11** на том же
[commit d09bc48564129b06dc4541f6aad50396524b7b60](https://github.com/chandra447/pi-hermes-memory/tree/d09bc48564129b06dc4541f6aad50396524b7b60).
Матрица двадцати Pi-плагинов выше остаётся закреплённым снимком **21.10.2026**,
не заявлением, что все двадцать повторно проверены на последних версиях.

Для этого этапа выбраны наблюдённые издержки и отказы собственного runtime:

- **Окончание разбора:** native `agent_end` может предшествовать восстановлению
  пустого ответа. Runtime сохраняет привязку пакета до публичного command-context
  `waitForIdle`; пользовательское прерывание отдельно освобождает команду.
- **Ошибки:** некорректный task label не означает отказ базы. Диагноз опирается
  на структурированный код, причём настоящий native storage code имеет приоритет
  над похожим на validation текстом.
- **Wiki:** один согласованный read snapshot на операцию и повторное использование
  проверок общих источников внутри него. Следующий вызов проверяет файлы и версии
  заново; publication сохраняет отдельные проверки до и после блокировки.
- **Запись:** обычный индекс `episodes(role,time DESC)` ускоряет поиск кандидатов
  дедупликации. Исходники, окно/правило дедупликации, старые writers и `WAL/FULL`
  не заменяются; новых primary tables и миграции schema нет.
- **Секреты:** расширено распознавание значений credentials до новой записи.
  Имена переменных, обычные инструкции о `.env` и Unicode не запрещены.
  История не переписывается; фильтр шаблонов не является полной security-границей.

Не перенесены фоновые review/flush/consolidation Hermes, blanket threat-scanner,
usage-записи на чтении, TTL/FIFO и автоматический межпроектный scope. Workbench
обучения, соседние источники/временной поиск и процедурная память остаются отдельными
кандидатами следующего этапа, а не скрытым расширением этого patch-релиза.
Холодная перестройка FTS sidecar также не изменена.

Это независимая реализация выбранных механизмов, без vendored upstream-кода.
Реальные три раунда, совместимость и ограничения интерпретации —
в [проверке 0.8.2](VALIDATION.md#release-082).

<a id="catalog-085"></a>
## Весь каталог pi.dev: 39 memory-пакетов, 25.10.2026

[Выдача Pi Packages](https://pi.dev/packages?name=memory) на 25.10.2026 содержит 39 пакетов.
Первые двадцать — те же, что в матрице 21.10 (порядок немного сменился). Ниже — пакеты 21–39
и недавно опубликованный `pi-sessions`. Проверены опубликованные npm-архивы указанных версий:
entrypoint, хранение, захват, выдача, модельные вызовы. Чужие install/build-скрипты не запускались.
Downloads — неделя 16–22.10.2026 по npm API. Это сравнение механизмов, а не рейтинг качества.

| Пакет | Хранение и захват | Модель/сервер | Происхождение фактов | Решение для huimem |
|---|---|---|---|---|
| [@rohirik/pi-ltm](https://github.com/RohiRIK/OpenLtm) 2.21.1 | SQLite + FTS5, общий для Claude Code/OpenCode/Pi; session extraction, janitor | embeddings (llama.cpp), janitor-LLM (Ollama), Bun/MCP-процесс | file anchors и stale, но текст ассистента может стать памятью | нового нет |
| [@reddb-io/red-skills-memory](https://www.npmjs.com/package/@reddb-io/red-skills-memory) 4.7.3 | Markdown-only или граф RedDB; store-evidence, claim-check | опционально extraction/vector/MCP | самая строгая governed-цитата из всех новых | уже есть: точная цитата обязательна |
| [open-zk-kb](https://www.npmjs.com/package/open-zk-kb) 1.4.4 | Markdown + SQLite FTS5 + ONNX-векторы | локальные ONNX embeddings, MCP, Bun | hashes, reviewed tokens | fingerprint проекции уже есть (receipts) |
| [@samfp/pi-memory](https://www.npmjs.com/package/@samfp/pi-memory) 1.6.1 | SQLite lessons/events; консолидация в конце сессии | обязательная LLM-консолидация | confidence ≥ 0.8, без точного источника | не брать |
| [pi-continual-harness](https://www.npmjs.com/package/pi-continual-harness) 0.20.0 | состояние в ветке Pi + Markdown; ручной `/refine` | опциональный proposer | поле evidence, откат ветки | атомарные типизированные изменения уже есть |
| [pi-memory-wiki-all-you-need](https://github.com/kht6163/memory-wiki-all-you-need) 0.26.1 | центральный Node/SQLite-сервер, FTS5, очередь ходов | LLM курирует каждый ход; опционально embeddings | ревизии и источник хода, но факты пишет LLM | раздельные stable/per-prompt блоки уже есть |
| [pi-session-memory](https://www.npmjs.com/package/pi-session-memory) 0.7.18 | SQLite-индекс исходных JSONL, `fetch_session` | опционально локальный Jev | оригиналы канонические | атомарная пересборка индекса — кандидат на потом |
| [@tpsdev-ai/pi-flair](https://www.npmjs.com/package/@tpsdev-ai/pi-flair) 0.62.0 | внешний сервис Flair/Harper | embeddings, Ed25519, сервер | подписи, но semantic-хранилище | не брать |
| [@vshulcz/pi-deja](https://www.npmjs.com/package/@vshulcz/pi-deja) 0.23.1 | локальный индекс сессий 40+ агентов; recall на старте, на промпте, при работе с файлом | без LLM | ссылки на исходные сессии | **взято в 0.8.5**: записи, ссылающиеся на файл, при его чтении или правке |
| [@cad0p/pi-tree-navigator](https://www.npmjs.com/package/@cad0p/pi-tree-navigator) 0.3.0 | вехи и сжатие ветки сессии | модель пишет сводку ветки | — | это управление контекстом, не память |
| [pi-ext-int-search](https://github.com/axelbaumlisto/pi-web-access) 1.7.0 | поиск по JSONL, Markdown, Claude Recall, git; `rg`/`git` | без LLM для поиска | location/score, но без полномочий | статус деградации у huimem уже есть |
| [pi-dejavu-memory](https://www.npmjs.com/package/pi-dejavu-memory) 1.4.3 | тонкий MCP-клиент удалённого DejaVu | удалённый сервер | на сервере | не брать |
| [pi-persistent-intelligence](https://www.npmjs.com/package/pi-persistent-intelligence) 0.17.4 | JSONL/Markdown/FTS; кандидат → review → promotion | опционально qmd, таймеры | классы доверия, review перед promotion | у huimem строже: accepted только из слов пользователя |
| [@codemem/pi-extension](https://www.npmjs.com/package/@codemem/pi-extension) 0.46.3 | SQLite CodeMem через CLI/viewer; ingestion событий Pi | embeddings по умолчанию | метаданные backend | дедупликация блока уже есть |
| [@cloudfrog/memory](https://www.npmjs.com/package/@cloudfrog/memory) 1.7.2 | внешний `memory serve` + SQLite; захват prompt/task/compaction | сервер, MCP | категории, без точной цитаты | не брать |
| [pi-total-recall](https://github.com/samfoy/pi-total-recall) 1.9.1 | три стора: pi-memory + session-search + knowledge-search | LLM-консолидация, опционально embeddings | факты пишет модель | выбор по релевантности уже есть |
| [@ilya-lesikov/pi-pi](https://www.npmjs.com/package/@ilya-lesikov/pi-pi) 1.15.1 | агентская платформа; поиск по истории | модельные воркеры | записей с источником нет | не память в нашем смысле |
| [basemind-opencode](https://www.npmjs.com/package/basemind-opencode) 0.31.0 | tree-sitter code-map, RAG по документам, git blame через MCP | MCP, reranker, OCR | content-addressed | OMP уже даёт LSP/grep/git |
| [@openlines/nmnm-pi](https://www.npmjs.com/package/@openlines/nmnm-pi) 0.4.5 | локальный SQLite; pinned-first блок | без фоновой LLM | source `"pi"` | обязательные записи впереди уже есть |
| [pi-sessions](https://www.npmjs.com/package/pi-sessions) 0.21.1 | SQLite-индекс сессий, handoff, автозаголовки | handoff через модель; индекс без LLM | ссылки на исходные сессии | атомарная пересборка индекса — кандидат на потом |

**Обновления первых двадцати с 21.10** (сравнение опубликованных архивов): pi-hermes-memory 0.9.11
вызывает модели через `ctx.modelRegistry` и сохраняет причину отказа provider; pi-blackhole 0.5.16
выключает observational memory в подагентах и ограничивает кеш JSONL 128 MiB; pi-openviking 0.1.23
сбрасывает recall только при релевантных изменениях; pi-optchat 0.9.2 — lifecycle-исправления окон.
bunshin, mem0, henryqw, amaster pi-memory, librarian, goosedump, state-flow, doc-bridge —
сопровождение без нового механизма памяти. Подагенты huimem уже различает с 0.6.x.

**Вывод.** Из 39 пакетов без фоновой модели работают немногие: pi-deja, nmnm, pi-ext-int-search,
индексы сессий. Обязательную цитату из сообщения пользователя или файла с проверкой hash кодом
не требует ни один: red-skills и persistent-intelligence ближе всех, но допускают promotion по
review, а не по слову пользователя. Почти всё, что можно перенести без LLM, сервера и смены
схемы, в huimem уже есть. Нового — одно: напоминание о сохранённых записях в момент работы с
файлом (pi-deja). Оно перенесено в 0.8.5 как навигация, без автоподстановки текста записи.


