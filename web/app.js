"use strict";

const element = id => document.getElementById(id);
const resources = ["Medicine", "Shelter", "Nutrition"];
const units = ["kits", "kits", "parcels"];
const number = new Intl.NumberFormat();
const format = value => value === null ? "—" : number.format(value);
// The server returns the starting resources. Edits stay in the local draft until submitted.
let game;
let draft = [];
let busy = false;

const escape = value => String(value).replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[char]);

const weight = cargo => cargo.reduce((total, quantity, index) => total + quantity * game.weights[index], 0);
const requestFor = id => game.requests.find(request => request.id === id);
const quantities = cargo => cargo.map((count, i) => `${format(count)} ${resources[i].toLowerCase()}`).join(" · ");

// The same endpoint draws a date, replays it, or evaluates a submitted plan.
async function load(payload) {
  if (busy) return;
  busy = true;
  for (const id of ["confirm", "new-day", "replay", "suggest"]) element(id).disabled = true;
  element("error").hidden = true;
  try {
    const response = await fetch("/api/plan", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    game = data;
    draft = [];
    render();
    (game.finished ? element("results").querySelector("h2") : element("date")).focus();
  } catch (error) {
    element("error").textContent = error.message;
    element("error").hidden = false;
  } finally {
    busy = false;
    element("loading").hidden = true;
    element("new-day").hidden = false;
    element("new-day").disabled = false;
    element("replay").hidden = !game?.finished;
    element("replay").disabled = false;
    if (game && !game.finished) updateDraft();
  }
}

function render() {
  const date = new Date(game.day + "T00:00:00Z");
  element("date").textContent = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "long", timeZone: "UTC"
  }).format(date);
  const slots = Object.values(game.hubs).reduce((total, hub) => total + hub.slots, 0);
  element("daily-summary").textContent = game.finished
    ? `${game.requests.length} emergency requests · Plan submitted`
    : `${game.requests.length} emergency requests · ${slots} dispatch slots across three hubs`;
  element("brief").hidden = false;
  element("game").hidden = game.finished;
  element("results").hidden = !game.finished;
  if (game.finished) renderResults();
  else renderBoard();
}

function renderBoard() {
  const waiting = game.requests;
  const recommended = game.recommendation[0]?.id;
  element("requests").innerHTML = waiting.map(request => {
    const hoursLeft = request.deadline;
    return `<article class="request ${recommended === request.id ? "recommended" : ""}">
      <div class="request-head">
        <div><h3>${escape(request.location)} · ${escape(request.kind)}</h3>
          <small class="muted">${escape(request.id)} · ${format(request.population)} affected</small></div>
        <span class="badge ${request.eta > hoursLeft ? "warn" : ""}">${hoursLeft} h deadline</span>
      </div>
      <p>${quantities(request.need)}</p>
      <p class="muted">Assigned hub · ${escape(game.hubs[request.hub].name)}</p>
      <p class="muted">Estimated transit ${format(request.eta)} h</p>
      <details><summary>Fuzzy priority ${request.score}/100${recommended === request.id ? " · AI first choice" : ""}</summary>
        <p>Strongest rules: ${escape(request.reason)}.</p></details>
      <button class="quiet" type="button" data-add="${escape(request.id)}">Add to plan</button>
    </article>`;
  }).join("") || "<p>No requests on this date.</p>";
  renderDraft();
}

function historyItem(request) {
  const events = request.history.map(escape).join(" → ");
  return `<article><h3>${escape(request.location)} · ${escape(request.id)}</h3><p>${events}. ${escape(request.explanation)}</p>
    ${request.cargo.some(Boolean) ? `<p class="muted">${quantities(request.cargo)}</p>` : ""}</article>`;
}

function renderDraft() {
  element("shipments").innerHTML = draft.map((shipment, i) => {
    const request = requestFor(shipment.id);
    return `<article class="shipment">
      <div class="shipment-head"><h3>${escape(request.location)} · ${escape(request.kind)}</h3>
        <button class="quiet" type="button" data-remove="${i}" aria-label="Remove ${escape(request.id)}">Remove</button></div>
      <div class="quantities">${resources.map((resource, j) => `<label>${resource}
        <input type="number" required min="0" max="${request.need[j]}" step="1" value="${shipment.cargo[j]}"
          data-shipment="${i}" data-resource="${j}"></label>`).join("")}</div>
      <small class="muted" id="weight-${i}"></small>
    </article>`;
  }).join("");
  updateDraft();
}

function remainingHubs() {
  // Copy stock arrays so editing or removing a shipment never alters the starting snapshot.
  const hubs = Object.fromEntries(Object.entries(game.hubs).map(([id, hub]) => [
    id, {...hub, stock: [...hub.stock]}
  ]));
  for (const shipment of draft) {
    const hub = hubs[requestFor(shipment.id).hub];
    hub.stock = hub.stock.map((available, i) => available - shipment.cargo[i]);
    hub.slots -= 1;
    hub.kg -= weight(shipment.cargo);
  }
  return hubs;
}

// Preview validation gives immediate feedback. The server validates the submitted plan again.
function updateDraft() {
  const hubs = remainingHubs();
  element("stock").innerHTML = Object.entries(hubs).map(([id, hub]) => `<article>
    <h3>${escape(hub.name)}</h3>
    <small>${hub.slots} slots left · ${Number.isFinite(hub.kg) ? format(hub.kg) : "—"} kg cargo left</small>
    <ul>${hub.stock.map((count, i) => `<li><span>${resources[i]} ${units[i]}</span>
      <strong>${Number.isFinite(count) ? format(count) : "—"}</strong>
      <meter aria-label="${resources[i]} stock" min="0" max="${Math.max(1, game.hubs[id].stock[i])}"
        value="${Math.max(0, count || 0)}"></meter></li>`).join("")}</ul></article>`).join("");

  let issue = "";
  for (const [i, shipment] of draft.entries()) {
    const mass = weight(shipment.cargo);
    const request = requestFor(shipment.id);
    const limit = game.hubs[request.hub].per_trip_kg;
    element(`weight-${i}`).textContent = `${Number.isFinite(mass) ? format(mass) : "—"} / ${format(limit)} kg per shipment`;
    if (shipment.cargo.some((count, j) => !Number.isInteger(count) || count < 0 || count > request.need[j])) {
      issue = "Enter whole quantities between zero and the requested amount.";
    } else if (!mass || mass > limit) {
      issue = "Each shipment needs cargo within its weight limit.";
    }
  }
  if (Object.values(hubs).some(hub => hub.slots < 0 || hub.kg < 0 || hub.stock.some(count => count < 0))) {
    issue = "Your draft exceeds a hub’s stock, slots, or daily cargo capacity.";
  }
  element("plan-message").textContent = issue || (draft.length
    ? `${draft.length} shipment${draft.length === 1 ? "" : "s"} planned. Unplanned requests receive no aid today.`
    : "Add a request to edit its cargo, or load the AI recommendation.");
  element("confirm").disabled = busy || Boolean(issue);
  element("suggest").disabled = busy || !game.recommendation.length;
  for (const button of element("requests").querySelectorAll("[data-add]")) {
    const planned = draft.some(shipment => shipment.id === button.dataset.add);
    const hub = hubs[requestFor(button.dataset.add).hub];
    button.textContent = planned ? "In your plan" : hub.slots <= 0 ? "No slots left" : "Add to plan";
    button.disabled = busy || planned || hub.slots <= 0;
  }
}

function renderResults() {
  const comparison = game.comparison;
  const rows = [["Your plan", comparison.player], ["Fuzzy priority", comparison.fuzzy], ["First come, first served", comparison.fifo], ["Recorded baseline", comparison.recorded]];
  const locations = Object.keys(comparison.player.coverage);
  element("results").innerHTML = `<div class="result-box">
    <h2 tabindex="-1">Daily results</h2>
    <div class="scroll"><table><thead><tr><th scope="col">Policy</th><th scope="col">Estimated beneficiaries</th>
      <th scope="col">Mean lateness</th><th scope="col">Fairness</th><th scope="col">Critical with no service</th></tr></thead><tbody>
      ${rows.map(([label, m]) => `<tr><th scope="row">${label}</th><td>${format(m.beneficiaries)}</td>
      <td>${m.delay === null ? "—" : `${format(m.delay)} h · ${m.delay_samples} shipments`}</td>
      <td>${format(m.fairness)}</td><td>${format(m.critical_open)}</td></tr>`).join("")}</tbody></table></div>
    <p class="muted">Simulated lateness measures time past the deadline. The recorded baseline uses the dataset’s delay and beneficiary fields. Fairness measures how evenly locations were covered, from 0 to 1.</p>
    <details><summary>Coverage by location</summary>
      <div class="scroll"><table><thead><tr><th scope="col">Location</th>${rows.map(([label]) => `<th scope="col">${label}</th>`).join("")}
      </tr></thead><tbody>${locations.map(location => `<tr><th scope="row">${escape(location)}</th>${rows.map(([, m]) =>
        `<td>${format(m.coverage[location] ?? null)}%</td>`).join("")}</tr>`).join("")}</tbody></table></div></details>
    <details class="history"><summary>Final request history</summary>${game.requests.map(historyItem).join("")}</details>
  </div>`;
}

element("requests").addEventListener("click", event => {
  const button = event.target.closest("[data-add]");
  if (!button || button.disabled || busy) return;
  const request = requestFor(button.dataset.add);
  const hub = remainingHubs()[request.hub];
  const limit = Math.max(0, Math.min(hub.kg, hub.per_trip_kg));
  const available = request.need.map((need, i) => Math.max(0, Math.min(need, hub.stock[i])));
  const kg = weight(available);
  const cargo = kg > limit ? available.map(count => Math.floor(count * limit / kg)) : available;
  draft.push({id: request.id, cargo});
  renderDraft();
  element("shipments").querySelector(`[data-shipment="${draft.length - 1}"]`).focus();
});

element("draft").addEventListener("input", event => {
  if (!event.target.matches("[data-shipment]")) return;
  const {shipment, resource} = event.target.dataset;
  draft[shipment].cargo[resource] = event.target.valueAsNumber;
  updateDraft();
});

element("draft").addEventListener("click", event => {
  const button = event.target.closest("[data-remove]");
  if (!button || busy) return;
  const [removed] = draft.splice(Number(button.dataset.remove), 1);
  renderDraft();
  element("requests").querySelector(`[data-add="${removed.id}"]`)?.focus();
});

element("draft").addEventListener("submit", event => {
  event.preventDefault();
  if (!element("confirm").disabled) load({day: game.day, draft, finish: true});
});

element("suggest").addEventListener("click", () => {
  draft = game.recommendation.map(shipment => ({...shipment, cargo: [...shipment.cargo]}));
  renderDraft();
});

element("replay").addEventListener("click", () => load({day: game.day}));
element("new-day").addEventListener("click", () => load({previous: game?.day}));
load({});
