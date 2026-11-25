# Ledgerline defect patches

Each patch reintroduces one CSV import bug class into the healthy Ledgerline importer
(`src/import/import-payments.ts`). Every one of them is silent: the upload still succeeds and the page
still says "Import successful", so only comparing the re-exported data with the source reveals it.

Apply a patch to a copy of `apps/demo-app`, never to the original:

```sh
cp -R apps/demo-app /tmp/ledgerline-defect && cd /tmp/ledgerline-defect
git apply defects/sign-flip.patch
```

Paths inside the patches are relative to `apps/demo-app` (for example `a/src/import/import-payments.ts`).
The seed script (`src/seed.ts`) shares no code with `src/import` or `src/csv`, so a seeded source
workspace stays correct whichever patch is applied.

| Defect file              | Bug class                                                                                                 | Public reference                                                                                                                           | What changes in the data                                                                                                                                                                                      | Label                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `sign-flip.patch`        | Importer applies an "incomes are positive" sign convention to a file that already uses the ledger's signs | [we-promise/sure#4754](https://github.com/we-promise/sure/pull/4754), "Re-importing Sure's own transactions.csv export flips every amount" | Every `amount` is negated: `17104.23` becomes `-17104.23`, `-5.10` becomes `5.10`. Row count unchanged.                                                                                                       | Recreated defect on a controlled demo app |
| `comma-split.patch`      | Lines split on `,` without honoring RFC 4180 quoting                                                      | Common CSV bug class (no single public report)                                                                                             | Quoted fields are mangled: `ACME WASTE, INC.` becomes `ACME WASTE`, `Smith "Bros" Hauling LLC` keeps its doubled quotes, and a vendor with an embedded line break loses its second line. Row count unchanged. | Recreated defect on a controlled demo app |
| `drop-duplicates.patch`  | "Skip duplicate rows" by hashing whole rows, which drops legitimate identical payments                    | Common CSV bug class (no single public report)                                                                                             | Repeated identical rows collapse to one. The fixture's two identical `PV09210004444` payments import as one, and the banner reports one fewer payment.                                                        | Recreated defect on a controlled demo app |
| `cents-truncation.patch` | Amount parsed with an integer parse, dropping the fractional part                                         | Common CSV bug class (no single public report)                                                                                             | Cents are lost: `17104.23` becomes `17104.00`, `-5.10` becomes `-5.00`, `0.07` becomes `0.00`. Row count unchanged.                                                                                           | Recreated defect on a controlled demo app |
| `column-order.patch`     | Columns mapped by a hard-coded position order that differs from the exporter's                            | [actualbudget/actual#3154](https://github.com/actualbudget/actual/issues/3154), CSV import field-mapping bug                               | `department_name` and `vendor_name` are swapped on every row. An empty department becomes an empty vendor. Row count unchanged.                                                                               | Recreated defect on a controlled demo app |

`test/defects.test.ts` applies each patch to a temporary copy, runs the browser-equivalent round trip
(export, create workspace, multipart upload, re-export) and asserts both the success banner and the exact
data change listed above.
