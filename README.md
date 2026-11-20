# Humanitarian Air Bridge | Daily Dispatch

One playthrough covers one randomly selected date from the supplied emergency logistics dataset. Decide how to allocate medicines, shelter kits, and nutrition parcels across that day's requests.

## Run locally

Open PowerShell in the folder containing `app.py` and run:

```powershell
py app.py
```

Use `python app.py` if `py` is unavailable. Python 3.10 or newer is required. Open http://127.0.0.1:8000 and leave the terminal open. If the previous simulator is running, stop it with Ctrl+C before starting this version.

## Play a day

1. Opening the game draws a random date with at least two emergency requests. The board loads that date's requests, assigned hubs, opening stock, and daily transport limits.
2. Add requests to your plan and edit the quantities you want to send. Live meters show remaining stock, cargo capacity, and dispatch slots at each hub. Every shipment consumes one slot at its assigned hub and can carry up to that hub's per-trip capacity. Load the AI recommendation to start with an editable draft.
3. Submit the whole plan. Requests that were not selected are unfulfilled. The results compare your plan with fuzzy priority, first come first served, and the recorded baseline for that date.
4. Replay the same date to test a different allocation, or draw another date. Each new draw excludes the date currently on screen.

## AI and evaluation

The fuzzy priority rules combine urgency, severity, time sensitivity, medical need, the population affected, and vulnerability. The score is the firing-strength-weighted mean of the rule outputs. The AI uses it to order requests. First come first served uses the request timestamp. Both policies use the same stock, transport limits, and loading rules.

The finite-state machine records Pending → Dispatched → Fulfilled or Partially fulfilled for selected requests. Pending requests without a shipment become Unfulfilled. Each request can receive one shipment. The day is planned as a batch, with all its requests visible. There is no simulated clock between submissions or stock carried across dates.

Simulated lateness is the time by which estimated transit exceeds a request's time sensitivity. Estimated beneficiaries use the average delivered fraction across requested resource types, multiplied by the affected population. Figures are summed across requests and may include overlapping populations. Fairness is Jain's index across location coverage rates. Recorded outcomes use the dataset's original beneficiary and delay fields, which can differ in definition from the simulated metrics.

The game assumes that a medicine kit weighs 2 kg, a shelter kit 15 kg, and a nutrition parcel 5 kg. A missing transit estimate uses an accessibility-based fallback. The full-dataset evaluator includes all dates, even dates with only one request:

```powershell
py evaluate.py
```

| File | Purpose |
| --- | --- |
| `app.py` | Random date selection, plan API, and local server |
| `simulation.py` | CSV loading, fuzzy inference, state transitions, allocation, and metrics |
| `evaluate.py` | Full-dataset comparison |
| `web/` | Dispatch board and results |
| `data/` | Five supplied synthetic CSV files |

## Run the tests

From the project folder, run:

```powershell
py -m unittest discover -s tests -v
```

Use `python` in place of `py` if needed. The tests use Python's built-in
`unittest`. They start their own temporary localhost server for HTTP tests,
so you can run them without opening the game.

| Test file | Coverage |
| --- | --- |
| `tests/test_daily_dispatch.py` | Day selection and replay, full and partial shipments, exact and exceeded limits, missing transit estimates, state transitions, priority and FIFO ordering, and AI draft checks across all playable dates |
| `tests/test_http.py` | Frontend files served over HTTP, plan submission and replay, malformed requests, and retry after an invalid shipment |

Run `evaluate.py` separately to generate the aggregate results for your report.
