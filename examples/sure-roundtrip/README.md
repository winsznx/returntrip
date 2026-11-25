# Sure, before and after PR #4754

[Sure](https://github.com/we-promise/sure) is an open-source personal finance app (AGPL-3.0). On 6 November 2026 it merged [PR #4754](https://github.com/we-promise/sure/pull/4754):

> Re-importing Sure's own `transactions.csv` export flips every amount, so expenses come back as income and both legs of a transfer change direction.

This example points ReturnTrip at the real, unmodified app, from its own published image, at the commit just before that fix (`44aad3a`) and at the fix itself (`cd5ad7e`). Nothing about Sure is changed or bundled here. The config is the only integration.

## Run it

Requires Docker, plus everything in the main README.

```sh
examples/sure-roundtrip/scripts/sure-stack.sh up buggy        # Sure at 44aad3a on 127.0.0.1:3300
node apps/cli/bin/returntrip.js verify --config examples/sure-roundtrip/sure-44aad3a.yaml
examples/sure-roundtrip/scripts/sure-stack.sh down
```

For the negative control, run `up fixed` and verify with `sure-cd5ad7e.yaml`: the same journey against the fix. Each config's seed refuses to run unless the container really is that commit.

## How it's wired

| Piece                                    | What it does                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/sure-stack.sh`                  | Downloads Sure's own `compose.example.yml` at the pinned commit and starts web, worker, Postgres and Redis from the image pinned by digest, on loopback only.                                                                                                                                                         |
| `seed_sure.rb`                           | Runs inside the container with `rails runner`. It creates a source family with 250 transactions and an empty restore family, writing directly through Sure's models so the importer under test never touches the reference data.                                                                                      |
| `source.csv`                             | 250 City of Chicago payments in Sure's `transactions.csv` layout, built by `scripts/prepare-source.ts`. Each row has a unique `rt-NNNN` note, so differences are reported per transaction.                                                                                                                            |
| `sure-44aad3a.yaml`, `sure-cd5ad7e.yaml` | Attached mode, so Sure is verified but never repaired. Kane logs in, exports the family data zip, imports `transactions.csv` into the empty family through Sure's import wizard with its default settings, and exports again. ReturnTrip extracts `transactions.csv` from each zip and keeps the archive as evidence. |

The restore objective never mentions the sign setting. It takes the path a person would take: map the columns and keep the defaults. On `44aad3a` the default is "Incomes are positive", which the PR says negates every row of Sure's own export.
