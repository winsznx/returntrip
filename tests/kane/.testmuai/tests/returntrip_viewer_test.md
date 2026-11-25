---
mode: testing
max_steps: 50
timeout: 300
target: chrome
---

# Session: returntrip_viewer

## Step 1
Go to http://127.0.0.1:4380/. Verify the main heading says 'Import successful.' and 'Now prove it.'. Click 'Open the recorded run'. Verify the page shows 'Repaired and verified' and the label 'Recreated defect on a controlled demo app'. In the record by record section, verify a row shows the trusted source amount '17104.23' and the export after restore amount '-17104.23'. Then click 'Attempt 2, after repair' and verify the page shows '1,000 / 1,000'.
