
"use strict";

// 1. Global variables and config

// Helper function to access HTML elements using their IDs.
const element = id => document.getElementById(id);

// Names and units of the three humanitarian resource categories.
const resources = ["Medicine", "Shelter", "Nutrition"];
const units = ["kits", "kits", "parcels"];

// Used to display numbers in a readable format (e.g. 1,000).
const number = new Intl.NumberFormat();
const format = value => value === null ? "—" : number.format(value);

// Stores the current scenario received from the backend.
let game;

// Stores the shipments currently being edited by the user.
// Changes remain in this local draft until the plan is submitted.
let draft = [];

// Prevents multiple requests from being submitted simultaneously.
let busy = false;


// 2.Helper functions

// Escapes special HTML characters to prevent user or dataset
// values from being interpreted as HTML when displayed.
const escape = value => String(value).replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[char]);

// Calculates the total shipment weight using the quantity
// of each resource and its corresponding weight.
const weight = cargo => cargo.reduce(
  (total, quantity, index) => total + quantity * game.weights[index], 0
);

// Finds and returns an emergency request using its unique ID.
const requestFor = id => game.requests.find(request => request.id === id);

// Formats shipment quantities into a readable description.
const quantities = cargo => cargo.map(
  (count, i) => `${format(count)} ${resources[i].toLowerCase()}`
).join(" · ");


// 3. loading and communicating wiht the backend

// Sends a request to the backend to load a new scenario,
// replay the current day, or evaluate the submitted plan.
async function load(payload) {

  // Stop if another request is already being processed.
  if (busy) return;

  busy = true;

  // Disable action buttons while the backend processes the request.
  for (const id of ["confirm", "new-day", "replay", "suggest"]) {
    element(id).disabled = true;
  }

  element("error").hidden = true;

  try {
    // Send the scenario information to the backend API.
    const response = await fetch("/api/plan", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload)
    });

    // Convert the backend response into JavaScript data.
    const data = await response.json();

    // Display an error if the backend request was unsuccessful.
    if (!response.ok) throw new Error(data.error);

    // Update the current scenario and clear the previous draft.
    game = data;
    draft = [];

    // Refresh the interface using the newly received data.
    render();

    // Move keyboard focus to the relevant section.
    (game.finished ? element("results").querySelector("h2") : element("date")).focus();

  } catch (error) {
    // Display any error returned by the backend or network.
    element("error").textContent = error.message;
    element("error").hidden = false;

  } finally {
    // Restore the interface after processing is complete.
    busy = false;
    element("loading").hidden = true;
    element("new-day").hidden = false;
    element("new-day").disabled = false;
    element("replay").hidden = !game?.finished;
    element("replay").disabled = false;

    // Refresh the draft validation if the scenario is still active.
    if (game && !game.finished) updateDraft();
  }
}


// 4.rendering the interface

// Updates the displayed date, request count, and available
// resources, then displays either the planning board or results.
function render() {

  // Format the selected simulation date.
  const date = new Date(game.day + "T00:00:00Z");

  element("date").textContent = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "long",
    timeZone: "UTC"
  }).format(date);

  // Calculate the total number of dispatch slots across all hubs.
  const slots = Object.values(game.hubs).reduce(
    (total, hub) => total + hub.slots, 0
  );

  // Display a summary depending on whether the plan is finished.
  element("daily-summary").textContent = game.finished
    ? `${game.requests.length} emergency requests · Plan submitted`
    : `${game.requests.length} emergency requests · ${slots} dispatch slots across three hubs`;

  element("brief").hidden = false;
  element("game").hidden = game.finished;
  element("results").hidden = !game.finished;

  // Display the appropriate screen.
  if (game.finished) renderResults();
  else renderBoard();
}


// 5.displaying emergency requests

// Creates the request cards shown to the user.
// The highest-ranked fuzzy recommendation is highlighted.
function renderBoard() {

  const waiting = game.requests;
  const recommended = game.recommendation[0]?.id;

  element("requests").innerHTML = waiting.map(request => {

    const hoursLeft = request.deadline;

    return `<article class="request ${recommended === request.id ? "recommended" : ""}">
      <div class="request-head">
        <div>
          <h3>${escape(request.location)} · ${escape(request.kind)}</h3>
          <small class="muted">${escape(request.id)} · ${format(request.population)} affected</small>
        </div>
        <span class="badge ${request.eta > hoursLeft ? "warn" : ""}">${hoursLeft} h deadline</span>
      </div>

      <p>${quantities(request.need)}</p>
      <p class="muted">Assigned hub · ${escape(game.hubs[request.hub].name)}</p>
      <p class="muted">Estimated transit ${format(request.eta)} h</p>

      <details>
        <summary>Fuzzy priority ${request.score}/100${recommended === request.id ? " · AI first choice" : ""}</summary>
        <p>Strongest rules: ${escape(request.reason)}.</p>
      </details>

      <button class="quiet" type="button" data-add="${escape(request.id)}">Add to plan</button>
    </article>`;

  }).join("") || "<p>No requests on this date.</p>";

  // Display the shipments currently selected by the user.
  renderDraft();
}


// 6. request history

// Displays the state transitions and final explanation
// associated with an individual emergency request.
function historyItem(request) {

  // Join the recorded FSM history events into a readable sequence.
  const events = request.history.map(escape).join(" → ");

  return `<article>
    <h3>${escape(request.location)} · ${escape(request.id)}</h3>
    <p>${events}. ${escape(request.explanation)}</p>
    ${request.cargo.some(Boolean) ? `<p class="muted">${quantities(request.cargo)}</p>` : ""}
  </article>`;
}


// 7.shipment draft management

// Displays editable shipment quantities for every request
// added to the user's daily allocation plan.
function renderDraft() {

  element("shipments").innerHTML = draft.map((shipment, i) => {

    const request = requestFor(shipment.id);

    return `<article class="shipment">
      <div class="shipment-head">
        <h3>${escape(request.location)} · ${escape(request.kind)}</h3>
        <button class="quiet" type="button" data-remove="${i}" aria-label="Remove ${escape(request.id)}">Remove</button>
      </div>

      <div class="quantities">
        ${resources.map((resource, j) => `<label>${resource}
          <input type="number" required min="0" max="${request.need[j]}" step="1"
            value="${shipment.cargo[j]}" data-shipment="${i}" data-resource="${j}">
        </label>`).join("")}
      </div>

      <small class="muted" id="weight-${i}"></small>
    </article>`;

  }).join("");

  // Recalculate remaining resources and validate the draft.
  updateDraft();
}


// 8.tracking remaining hub resources

// Creates a temporary copy of hub resources and subtracts
// the shipments in the current draft.
// The original starting resources are not modified.
function remainingHubs() {

  const hubs = Object.fromEntries(
    Object.entries(game.hubs).map(([id, hub]) => [
      id,
      {...hub, stock: [...hub.stock]}
    ])
  );

  // Deduct each planned shipment from its assigned hub.
  for (const shipment of draft) {

    const hub = hubs[requestFor(shipment.id).hub];

    // Reduce available stock, dispatch slots and cargo capacity.
    hub.stock = hub.stock.map(
      (available, i) => available - shipment.cargo[i]
    );

    hub.slots -= 1;
    hub.kg -= weight(shipment.cargo);
  }

  return hubs;
}


// 9.draft validation and resource checking

// Checks whether the user's current shipment plan follows
// the resource limits and displays validation messages.
// The backend performs its own validation again on submission.
function updateDraft() {

  const hubs = remainingHubs();

  // Display the remaining stock, slots and cargo capacity
  // for each supply hub after considering the current draft.
  element("stock").innerHTML = Object.entries(hubs).map(([id, hub]) => `
    <article>
      <h3>${escape(hub.name)}</h3>
      <small>${hub.slots} slots left · ${Number.isFinite(hub.kg) ? format(hub.kg) : "—"} kg cargo left</small>
      <ul>
        ${hub.stock.map((count, i) => `
          <li>
            <span>${resources[i]} ${units[i]}</span>
            <strong>${Number.isFinite(count) ? format(count) : "—"}</strong>
            <meter aria-label="${resources[i]} stock" min="0"
              max="${Math.max(1, game.hubs[id].stock[i])}"
              value="${Math.max(0, count || 0)}"></meter>
          </li>
        `).join("")}
      </ul>
    </article>
  `).join("");

  let issue = "";

  // Validate every shipment in the current draft.
  for (const [i, shipment] of draft.entries()) {

    const mass = weight(shipment.cargo);
    const request = requestFor(shipment.id);
    const limit = game.hubs[request.hub].per_trip_kg;

    // Display the shipment's calculated weight and permitted limit.
    element(`weight-${i}`).textContent =
      `${Number.isFinite(mass) ? format(mass) : "—"} / ${format(limit)} kg per shipment`;

    // Check that quantities are whole numbers within the requested amount.
    if (shipment.cargo.some((count, j) =>
      !Number.isInteger(count) || count < 0 || count > request.need[j]
    )) {
      issue = "Enter whole quantities between zero and the requested amount.";

    // Ensure that the shipment has cargo and does not exceed its
    // individual per-trip weight limit.
    } else if (!mass || mass > limit) {
      issue = "Each shipment needs cargo within its weight limit.";
    }
  }

  // Check whether the complete draft exceeds any hub's stock,
  // available dispatch slots or daily cargo capacity.
  if (Object.values(hubs).some(hub =>
    hub.slots < 0 || hub.kg < 0 || hub.stock.some(count => count < 0)
  )) {
    issue = "Your draft exceeds a hub’s stock, slots, or daily cargo capacity.";
  }

  // Display the current validation result or planning information.
  element("plan-message").textContent = issue || (draft.length
    ? `${draft.length} shipment${draft.length === 1 ? "" : "s"} planned. Unplanned requests receive no aid today.`
    : "Add a request to edit its cargo, or load the AI recommendation.");

  // Submission is disabled if the draft is invalid or the system is busy.
  element("confirm").disabled = busy || Boolean(issue);

  // The AI recommendation button is available when recommendations exist.
  element("suggest").disabled = busy || !game.recommendation.length;

  // Update each request button based on its current planning status.
  for (const button of element("requests").querySelectorAll("[data-add]")) {

    const planned = draft.some(
      shipment => shipment.id === button.dataset.add
    );

    const hub = hubs[requestFor(button.dataset.add).hub];

    button.textContent = planned
      ? "In your plan"
      : hub.slots <= 0
        ? "No slots left"
        : "Add to plan";

    // Prevent adding the same request twice or selecting a request
    // when its assigned hub has no remaining dispatch slots.
    button.disabled = busy || planned || hub.slots <= 0;
  }
}


// 10. displaying evaluation results

// Displays the submitted plan's results alongside the
// Fuzzy Priority, FIFO and recorded baseline comparisons.
function renderResults() {

  const comparison = game.comparison;

  // Prepare the policies and their corresponding evaluation metrics.
  const rows = [
    ["Your plan", comparison.player],
    ["Fuzzy priority", comparison.fuzzy],
    ["First come, first served", comparison.fifo],
    ["Recorded baseline", comparison.recorded]
  ];

  // Get all locations included in the coverage comparison.
  const locations = Object.keys(comparison.player.coverage);

  // Generate the evaluation results table.
  element("results").innerHTML = `<div class="result-box">

    <h2 tabindex="-1">Daily results</h2>

    <div class="scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">Policy</th>
            <th scope="col">Estimated beneficiaries</th>
            <th scope="col">Mean lateness</th>
            <th scope="col">Fairness</th>
            <th scope="col">Critical with no service</th>
          </tr>
        </thead>

        <tbody>
          ${rows.map(([label, m]) => `
            <tr>
              <th scope="row">${label}</th>
              <td>${format(m.beneficiaries)}</td>
              <td>${m.delay === null ? "—" : `${format(m.delay)} h · ${m.delay_samples} shipments`}</td>
              <td>${format(m.fairness)}</td>
              <td>${format(m.critical_open)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>

    <p class="muted">
      Simulated lateness measures time past the deadline. The recorded baseline
      uses the dataset’s delay and beneficiary fields. Fairness measures how
      evenly locations were covered, from 0 to 1.
    </p>

    <!-- Expandable table showing coverage percentages for each location. -->
    <details>
      <summary>Coverage by location</summary>
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Location</th>
              ${rows.map(([label]) => `<th scope="col">${label}</th>`).join("")}
            </tr>
          </thead>

          <tbody>
            ${locations.map(location => `
              <tr>
                <th scope="row">${escape(location)}</th>
                ${rows.map(([, m]) =>
                  `<td>${format(m.coverage[location] ?? null)}%</td>`
                ).join("")}
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </details>

    <!-- Expandable section showing the final FSM history of requests. -->
    <details class="history">
      <summary>Final request history</summary>
      ${game.requests.map(historyItem).join("")}
    </details>

  </div>`;
}


// 11.event listeners-adding shipments

// Handles clicks on the Add to Plan buttons.
// Event delegation allows dynamically generated request cards
// to use the same event listener.
element("requests").addEventListener("click", event => {

  const button = event.target.closest("[data-add]");

  if (!button || button.disabled || busy) return;

  const request = requestFor(button.dataset.add);

  // Get the remaining resources from the request's assigned hub.
  const hub = remainingHubs()[request.hub];

  // Determine the maximum permitted cargo weight for this shipment.
  const limit = Math.max(0, Math.min(hub.kg, hub.per_trip_kg));

  // Calculate the available quantity of each requested resource.
  const available = request.need.map((need, i) =>
    Math.max(0, Math.min(need, hub.stock[i]))
  );

  const kg = weight(available);

  // If the selected cargo exceeds the weight limit, scale down
  // its quantities proportionally to fit within the permitted limit.
  const cargo = kg > limit
    ? available.map(count => Math.floor(count * limit / kg))
    : available;

  // Add the request and its calculated cargo to the local draft.
  draft.push({id: request.id, cargo});

  renderDraft();

  // Move keyboard focus to the newly created shipment input.
  element("shipments")
    .querySelector(`[data-shipment="${draft.length - 1}"]`)
    .focus();
});


// 12. event listener- editing shipment quantities

// Updates the draft whenever the user changes a resource quantity.
element("draft").addEventListener("input", event => {

  // Ignore inputs that are not shipment quantity fields.
  if (!event.target.matches("[data-shipment]")) return;

  // Identify which shipment and resource were edited.
  const {shipment, resource} = event.target.dataset;

  // Update the corresponding quantity in the local draft.
  draft[shipment].cargo[resource] = event.target.valueAsNumber;

  // Recalculate cargo weight, stock and validation messages.
  updateDraft();
});


// 13. event listener- removing shipments

// Allows users to remove a shipment from their current plan.
element("draft").addEventListener("click", event => {

  const button = event.target.closest("[data-remove]");

  if (!button || busy) return;

  // Remove the selected shipment from the draft.
  const [removed] = draft.splice(Number(button.dataset.remove), 1);

  // Refresh the interface and restore keyboard focus to its request.
  renderDraft();

  element("requests")
    .querySelector(`[data-add="${removed.id}"]`)?.focus();
});


// event listener - submiting daily plan

// Handles submission of the user's completed allocation plan.
element("draft").addEventListener("submit", event => {

  // Prevent the browser from performing its default form submission.
  event.preventDefault();

  // Submit only when the current plan passes validation.
  if (!element("confirm").disabled) {
    load({
      day: game.day,
      draft,
      finish: true
    });
  }
});


// 15. event listener - ai reccomendaiton

// Loads the AI-generated fuzzy priority recommendation
// into the user's editable shipment plan.
element("suggest").addEventListener("click", () => {

  // Copy the recommended shipments and their cargo quantities.
  // Separate cargo arrays prevent changes from modifying the original
  // recommendation data.
  draft = game.recommendation.map(shipment => ({
    ...shipment,
    cargo: [...shipment.cargo]
  }));

  // Display and validate the suggested plan.
  renderDraft();
});


//16. event listener - replay and new scenario

// Replays the current date using the starting resources.
element("replay").addEventListener("click", () => load({
  day: game.day
}));

// Requests a new playable date from the backend.
// The current date is provided so it can be excluded from the next draw.
element("new-day").addEventListener("click", () => load({
  previous: game?.day
}));


// 17. initial application load

// Load the first available daily dispatch scenario when
// the application starts.
load({});
