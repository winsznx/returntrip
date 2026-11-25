# kane-adapter test fixtures

`kane-0.10.9/` holds real kane-cli 0.10.9 output captured on 2026-11-25 from `kane-cli run --agent`
against the local preflight target. Each run has its stdout (`.ndjson`) and stderr (`.stderr`).

| Run           | Exit code | Result                                         |
| ------------- | --------- | ---------------------------------------------- |
| `pf02-1-pass` | 0         | passed, navigate and verify                    |
| `pf02-2-fail` | 1         | failed, final verification (`result_code` 710) |
| `pf04-export` | 0         | passed, clicked Export CSV                     |
| `pf05-upload` | 0         | passed, uploaded a file through a file input   |

Two redactions were applied, and every other byte is as kane-cli wrote it:

- each `test_url` value is replaced with `https://test-manager.lambdatest.com/redacted`, because the
  original is a share link that grants access to the run;
- `/Users/mac` is replaced with `/home/user`.

The evidence pack from `pf02-2-fail` is not committed. It contains the account name and email, a
Test Manager share link and HAR request headers. Evidence pack tests build synthetic ZIP archives
in code instead and are labeled as synthetic.

`fake-kane.mjs` is a test double, not kane-cli. It replays one of these files to stdout with
configurable delays and exit code so process handling (cancellation, process-group kill,
deadlines) can be tested without spending Kane credits.

`sure/sure-44aad3a-family-export.zip` is a real family data export from Sure at commit 44aad3a
(written by rubyzip), captured by ReturnTrip's proxy on 2026-11-25. It holds only data ReturnTrip
seeded into a throwaway local instance: 250 public City of Chicago payments and test users
`@returntrip.test`. Every entry declares 0xFFFFFFFF sizes and carries the real ones in a Zip64
extra field, which is why it's here.
