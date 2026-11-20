"""Local server for the daily planning game. Run with py app.py."""
import json
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from random import choice

from simulation import BY_DAY, KG, Day, compare, metrics, outcomes

# Start with a choice to make. Single-request dates remain in the evaluation.
PLAYABLE_DATES = [day for day, requests in BY_DAY.items() if len(requests) >= 2]


def play(payload):
    """Build a fresh day and apply a submitted plan if the player confirms it."""
    day = payload.get("day")
    if day is None:
        previous = payload.get("previous")
        day = choice([date for date in PLAYABLE_DATES if date != previous])
    elif day not in PLAYABLE_DATES:
        raise ValueError("Choose a playable date.")
    # Rebuild from the CSVs on each call so replay restores stock and each plan is independent.
    session = Day(day)
    draft = payload.get("draft", [])
    finish = payload.get("finish", False)
    if not isinstance(draft, list) or len(draft) > len(session.requests) or type(finish) is not bool:
        raise ValueError("Invalid dispatch plan.")
    if finish:
        for shipment in draft:
            cargo = shipment["cargo"]
            if not isinstance(cargo, list):
                raise ValueError("Expected three cargo quantities.")
            session.dispatch(shipment["id"], cargo)
        session.finish("manual")
    requests = sorted(session.requests.values(), key=lambda request: -request.score)
    return {
        "day": day, "finished": finish, "hubs": session.limits, "weights": KG,
        "requests": [
            {
                "id": r.id, "hub": r.hub, "location": r.location, "kind": r.row["request_type"],
                "population": r.population, "need": r.demand, "deadline": int(r.row["time_sensitivity_hours"]),
                "eta": r.eta, "state": r.state.value, "cargo": r.allocated, "history": r.history,
                "explanation": r.explanation, "score": r.score, "reason": r.rules,
            }
            for r in requests
        ],
        "recommendation": [] if finish else recommendation(day),
        "comparison": {"player": metrics(outcomes(requests)), **compare([day])} if finish else None,
    }


def recommendation(day):
    session = Day(day)
    ordered = session.pending()
    session.finish("fuzzy")
    return [{"id": r.id, "cargo": r.allocated} for r in ordered if any(r.allocated)]


class Handler(SimpleHTTPRequestHandler):
    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/api/plan":
            self.send_error(404)
            return
        try:
            size = int(self.headers.get("Content-Length", 0))
            if not 0 < size <= 16000:
                raise ValueError("Invalid plan size.")
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict):
                raise ValueError("Expected a plan object.")
            self.send_json(play(payload))
        except (ValueError, KeyError, TypeError) as error:
            self.send_json({"error": f"Could not apply that plan. {error}"}, 400)


if __name__ == "__main__":
    handler = partial(Handler, directory=str(Path(__file__).with_name("web")))
    with ThreadingHTTPServer(("127.0.0.1", 8000), handler) as server:
        print("Open http://127.0.0.1:8000 to play.", flush=True)
        server.serve_forever()
