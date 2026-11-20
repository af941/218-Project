"""Daily aid allocation, fuzzy priorities, request states and evaluation."""
import csv
from collections import Counter
from datetime import date, timedelta
from enum import Enum
from pathlib import Path
from statistics import mean

RESOURCES = ("medicine", "shelter", "nutrition")
DEMAND = ("medicine_required_kits", "shelter_required_kits", "nutrition_required_parcels")
STOCK = ("medicine_stock_kits", "shelter_stock_kits", "nutrition_stock_parcels")
KG = (2, 15, 5)  # Assumed unit weights for the classroom simulation.
ETA_FALLBACK = {"High": 8, "Medium": 12, "Low": 16, "Restricted": 24}


def read_csv(name):
    with (Path(__file__).with_name("data") / f"{name}.csv").open(encoding="utf-8-sig") as file:
        return list(csv.DictReader(file))


# Requests join to destinations by location ID and to inventory and transport by date and hub ID.
REQUESTS = read_csv("emergency_requests")
HUBS = {row["hub_id"]: row for row in read_csv("supply_hubs")}
LOCATIONS = {row["location_id"]: row for row in read_csv("locations")}
DAILY_STOCK = {(r["date"], r["hub_id"]): r for r in read_csv("daily_hub_stock")}
SLOTS = {(r["date"], r["hub_id"]): r for r in read_csv("daily_flight_slots")}
DATES = sorted({day for day, _ in SLOTS})
BY_DAY = {day: [] for day in DATES}
for row in sorted(REQUESTS, key=lambda r: (r["request_datetime"], r["request_id"])):
    BY_DAY[row["request_datetime"][:10]].append(row)


class State(str, Enum):
    PENDING = "Pending"
    DISPATCHED = "Dispatched"
    FULFILLED = "Fulfilled"
    PARTIAL = "Partially fulfilled"
    UNFULFILLED = "Unfulfilled"


# Final states have no outgoing transitions, so completed requests cannot consume more stock.
TRANSITIONS = {
    State.PENDING: {State.DISPATCHED, State.UNFULFILLED},
    State.DISPATCHED: {State.FULFILLED, State.PARTIAL},
}


def fuzzy_priority(row, hours_left=None):
    """Zero-order Sugeno inference. Each rule returns a fixed score."""
    # Convert inputs to degrees in [0, 1] before evaluating the rule base.
    urgency = (int(row["urgency_level"]) - 1) / 4
    severity = (int(row["severity_level"]) - 1) / 4
    hours = int(row["time_sensitivity_hours"]) if hours_left is None else hours_left
    pressure = min(1, max(0, (72 - hours) / 66))
    reach = min(1, int(row["population_affected"]) / 5000)
    vulnerable = row["vulnerable_population"]
    vulnerability = min(1, int(vulnerable) / max(1, int(row["population_affected"]))) if vulnerable else 0.5
    medical = float(row["medical_emergency"] == "Yes")
    # Min is fuzzy AND, max is fuzzy OR, and 1 minus a membership is fuzzy NOT.
    rules = [
        ("urgent and severe", min(urgency, severity), 100),
        ("medical emergency with a tight deadline", min(medical, pressure), 95),
        ("large affected population or high vulnerability", max(reach, vulnerability), 78),
        ("some urgency or deadline pressure", max(urgency, pressure), 65),
        ("lower urgency and low severity", min(1 - urgency, 1 - severity), 25),
        ("general need", 0.2, 45),
    ]
    # A rule with a higher firing strength contributes more to the final score.
    score = sum(weight * output for _, weight, output in rules) / sum(weight for _, weight, _ in rules)
    strongest = sorted(rules, key=lambda rule: -rule[1])[:2]
    return round(score, 2), ", ".join(f"{label} ({weight:.2f})" for label, weight, _ in strongest if weight)


class Request:
    def __init__(self, row):
        self.row = row
        self.id = row["request_id"]
        self.hub = row["supply_hub"]
        self.location = LOCATIONS[row["location_id"]]["location"]
        self.demand = [int(row[key]) for key in DEMAND]
        self.population = int(row["population_affected"])
        self.score, self.rules = fuzzy_priority(row)
        self.state = State.PENDING
        self.history = [self.state.value]
        self.allocated = [0, 0, 0]
        self.served = 0
        self.late = None
        access = row["delivery_accessibility"] or LOCATIONS[row["location_id"]]["typical_accessibility"]
        self.eta = float(row["estimated_delivery_time_hours"] or ETA_FALLBACK[access])
        self.explanation = "Awaiting a decision."

    def transition(self, state):
        if state not in TRANSITIONS.get(self.state, set()):
            raise ValueError("This request has already been resolved.")
        self.state = state
        self.history.append(state.value)


class Day:
    """One planning snapshot with shared, mutable resources for each hub."""

    def __init__(self, day, scenario=100):
        self.day = day
        self.requests = {r["request_id"]: Request(r) for r in BY_DAY[day]}
        self.limits = {}
        for hub, info in HUBS.items():
            stock = DAILY_STOCK[day, hub]
            transport = SLOTS[day, hub]
            self.limits[hub] = {
                "name": info["hub_name"],
                "stock": [int(stock[key]) * scenario // 100 for key in STOCK],
                "slots": int(transport["flight_slots_available"]),
                "kg": int(float(transport["total_capacity_tonnes"]) * 1000),
                "per_trip_kg": int(float(info["aircraft_capacity_tonnes"]) * 1000),
            }

    def pending(self):
        return sorted(
            (r for r in self.requests.values() if r.state == State.PENDING),
            key=lambda r: (-r.score, r.row["request_datetime"], r.id),
        )

    def dispatch(self, request_id, cargo=None):
        request = self.requests[request_id]
        if request.state != State.PENDING:
            raise ValueError("This request has already been resolved.")
        limits = self.limits[request.hub]
        # Both the remaining daily cargo limit and the single-trip limit must hold.
        capacity = min(limits["kg"], limits["per_trip_kg"])
        if cargo is not None:
            if (not isinstance(cargo, list) or len(cargo) != len(KG)
                    or any(type(count) is not int or not 0 <= count <= min(need, stock)
                           for count, need, stock in zip(cargo, request.demand, limits["stock"]))
                    or not any(cargo)):
                raise ValueError("Enter a positive shipment within request demand and available hub stock.")
            if not limits["slots"] or sum(count * kg for count, kg in zip(cargo, KG)) > capacity:
                raise ValueError("That hub does not have enough transport slots or cargo capacity.")
        # One dedicated dispatch per request. Scale the available basket to
        # cargo capacity, keeping whole units and never exceeding stock.
        desired = [min(need, stock) for need, stock in zip(request.demand, limits["stock"])]
        mass = sum(count * kg for count, kg in zip(desired, KG))
        if not limits["slots"] or capacity <= 0 or mass == 0:
            request.transition(State.UNFULFILLED)
            request.explanation = (
                "No dispatch slots remained." if not limits["slots"]
                else "No usable daily cargo capacity remained." if capacity <= 0
                else "The hub had none of the requested supplies available."
            )
            return
        allocated = cargo if cargo is not None else [count * min(capacity, mass) // mass for count in desired]
        if not any(allocated):
            request.transition(State.UNFULFILLED)
            request.explanation = "Remaining cargo could not fit the available supplies."
            return
        request.transition(State.DISPATCHED)
        limits["slots"] -= 1
        limits["kg"] -= sum(count * kg for count, kg in zip(allocated, KG))
        limits["stock"] = [stock - used for stock, used in zip(limits["stock"], allocated)]
        request.allocated = allocated
        # Average the delivered shares of the resource types that were actually requested.
        coverage = mean(used / need for used, need in zip(allocated, request.demand) if need)
        request.served = round(request.population * coverage)
        request.late = max(0, request.eta - int(request.row["time_sensitivity_hours"]))
        full = allocated == request.demand
        request.transition(State.FULFILLED if full else State.PARTIAL)
        if full:
            request.explanation = "All requested supplies fit within stock and transport limits."
        elif cargo is not None:
            request.explanation = "The submitted shipment covers only part of the request."
        else:
            request.explanation = "Stock or cargo limits reduced the delivered quantities."

    def finish(self, policy):
        if policy == "fuzzy":
            for request in self.pending():
                self.dispatch(request.id)
        elif policy == "fifo":
            for request in self.requests.values():
                self.dispatch(request.id)
        else:
            for request in self.pending():
                request.transition(State.UNFULFILLED)
                request.explanation = "The player closed the day before dispatching this request."


def metrics(items):
    """Each item is (source row, beneficiaries, delay or None, status)."""
    counts = Counter()
    served_by_location = Counter()
    demand_by_location = Counter()
    delays = []
    critical_open = 0
    for row, served, delay, status in items:
        counts[status] += 1
        location = LOCATIONS[row["location_id"]]["location"]
        served_by_location[location] += served
        demand_by_location[location] += int(row["population_affected"])
        if delay is not None:
            delays.append(delay)
        if row["expert_priority_label"] == "Critical" and status in {"Unfulfilled", "Cancelled"}:
            critical_open += 1
    coverage = {loc: served_by_location[loc] / total for loc, total in sorted(demand_by_location.items()) if total}
    values = list(coverage.values())
    # Jain’s index measures equality of coverage rates. With zero service it is undefined.
    fairness = sum(values) ** 2 / (len(values) * sum(v * v for v in values)) if any(values) else None
    return dict(beneficiaries=sum(served_by_location.values()), delay=round(mean(delays), 2) if delays else None,
                delay_samples=len(delays), fairness=round(fairness, 3) if fairness is not None else None,
                critical_open=critical_open, status=dict(counts),
                coverage={loc: round(value * 100, 1) for loc, value in coverage.items()})


def outcomes(requests):
    return [(r.row, r.served, r.late, r.state.value) for r in requests]


def recorded(rows):
    return [(r, int(r["beneficiaries_served"]), float(r["delivery_delay_hours"])
             if r["delivery_delay_hours"] else None, r["fulfilment_status"].capitalize()) for r in rows]


def compare(days, scenario=100):
    result = {}
    for policy in ("fuzzy", "fifo"):
        observations = []
        for day in days:
            simulation = Day(day, scenario)
            simulation.finish(policy)
            observations.extend(outcomes(simulation.requests.values()))
        result[policy] = metrics(observations)
    # Recorded outcomes are taken from the CSV without applying simulated constraints.
    result["recorded"] = metrics(recorded([r for day in days for r in BY_DAY[day]]))
    return result


def session_dates(start, length):
    start = date.fromisoformat(start)
    days = [(start + timedelta(days=offset)).isoformat() for offset in range(length)]
    if any(day not in BY_DAY for day in days):
        raise ValueError("Choose a period within the dataset dates.")
    return days

