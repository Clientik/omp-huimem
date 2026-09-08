# Validation

Test environment: Windows, OMP 18.1.5, Bun 1.4.0, local endpoint on 127.0.0.1:8001,
Huihui-Qwen3.8-27B-abliterated-UD-Q4_K_XL.gguf, context capacity 65536.
No cloud provider was used in the live sequence. Raw user transcripts are not shipped.

| Scenario | Result | Seconds | Model calls | Output tokens |
| --- | --- | ---: | ---: | ---: |
| Save PostgreSQL 17 and Stripe | checkpoint 1, two recovered validation errors | 73.7 | 8 | 2224 |
| Recall in new session | correct | 6.0 | 1 | 120 |
| Replace Stripe with YooKassa | same record, version 2, checkpoint 2 | 69.8 | 4 | 2396 |
| Recall in new session | correct replacement and reason | 5.7 | 1 | 132 |

The source adapter and bundled adapter each have eight tests; the core has twelve.
They cover provenance rejection, stale records, versions, restarts, policy drift,
bounded context, visible failures and lack of forced continuation loops.
This repackaging preserves memory behavior. The bundle was also loaded directly in
a real OMP process and project_memory status completed successfully.

Still pending: repeated live trials, actual compaction, interrupted writes in OMP,
concurrent OMP sessions, branch isolation and total token cost over long tasks.
