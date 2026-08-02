const gamesElement = document.querySelector("#games");
const statusElement = document.querySelector("#status");
const statusDot = document.querySelector(".status-dot");
const refreshButton = document.querySelector("#refresh");

const periods = [
	{ value: "all_time", label: "All time" },
	{ value: "today", label: "Today" },
	{ value: "this_week", label: "This week" },
];

function setStatus(message, isError = false) {
	statusElement.textContent = message;
	statusDot.classList.toggle("error", isError);
}

async function getJson(url) {
	const response = await fetch(url, { headers: { Accept: "application/json" } });
	const payload = await response.json().catch(() => ({}));
	if (!response.ok || payload.ok === false) {
		throw new Error(payload?.error?.message || `Request failed (${response.status})`);
	}
	return payload;
}

function addText(parent, tag, text, className) {
	const element = document.createElement(tag);
	if (className) element.className = className;
	element.textContent = text;
	parent.append(element);
	return element;
}

function selectControl(label, options, value) {
	const wrapper = document.createElement("label");
	wrapper.textContent = label;
	const select = document.createElement("select");
	for (const option of options) {
		const item = document.createElement("option");
		item.value = option.value;
		item.textContent = option.label;
		item.selected = option.value === value;
		select.append(item);
	}
	wrapper.append(select);
	return { wrapper, select };
}

function renderTable(container, entries) {
	container.replaceChildren();
	if (entries.length === 0) {
		addText(container, "div", "No accepted scores yet.", "table-state");
		return;
	}

	const table = document.createElement("table");
	const head = document.createElement("thead");
	const headRow = document.createElement("tr");
	for (const label of ["Rank", "Player", "Score"]) addText(headRow, "th", label);
	head.append(headRow);
	table.append(head);

	const body = document.createElement("tbody");
	for (const entry of entries) {
		const row = document.createElement("tr");
		addText(row, "td", `#${entry.rank}`, "rank");
		addText(row, "td", entry.name || entry.player_id, "player");
		addText(row, "td", Number(entry.score).toLocaleString(), "score");
		body.append(row);
	}
	table.append(body);
	container.append(table);
}

function renderGame(game) {
	const card = document.createElement("article");
	card.className = "game-card";
	const heading = document.createElement("div");
	heading.className = "game-heading";
	const headingCopy = document.createElement("div");
	addText(headingCopy, "h2", game.name);
	addText(headingCopy, "p", game.slug, "game-slug");
	addText(heading, "span", `${game.rulesets.length} ruleset${game.rulesets.length === 1 ? "" : "s"}`, "rank-badge");
	heading.prepend(headingCopy);
	card.append(heading);

	const controls = document.createElement("div");
	controls.className = "controls";
	const rulesetOptions = game.rulesets.map((ruleset) => ({ value: ruleset.version, label: ruleset.version }));
	let ruleset = rulesetOptions[0]?.value || "";
	let period = "all_time";
	const rulesetControl = selectControl("Ruleset", rulesetOptions, ruleset);
	const periodControl = selectControl("Period", periods, period);
	controls.append(rulesetControl.wrapper, periodControl.wrapper);
	card.append(controls);

	const tableContainer = document.createElement("div");
	tableContainer.className = "table-wrap";
	card.append(tableContainer);

	async function loadLeaderboard() {
		ruleset = rulesetControl.select.value;
		period = periodControl.select.value;
		tableContainer.replaceChildren();
		addText(tableContainer, "div", "Loading scores…", "table-state");
		try {
			const query = new URLSearchParams({ ruleset_version: ruleset, top_limit: "100" });
			const payload = await getJson(`/v1/public/games/${encodeURIComponent(game.slug)}/leaderboards/${period}?${query}`);
			renderTable(tableContainer, payload.entries || []);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unable to load scores";
			const errorState = addText(tableContainer, "div", message, "table-state error");
			errorState.setAttribute("role", "alert");
		}
	}

	rulesetControl.select.addEventListener("change", loadLeaderboard);
	periodControl.select.addEventListener("change", loadLeaderboard);
	loadLeaderboard();
	return card;
}

async function loadCatalog() {
	refreshButton.disabled = true;
	setStatus("Loading games…");
	try {
		const payload = await getJson("/v1/public/games");
		gamesElement.replaceChildren();
		if (!payload.games?.length) {
			gamesElement.append(addText(document.createElement("div"), "div", "No active games are configured yet.", "loading-card"));
			setStatus("No active games");
			return;
		}
		for (const game of payload.games) gamesElement.append(renderGame(game));
		setStatus(`${payload.games.length} active game${payload.games.length === 1 ? "" : "s"}`);
	} catch (error) {
		gamesElement.replaceChildren();
		const message = error instanceof Error ? error.message : "Unable to load games";
		gamesElement.append(addText(document.createElement("div"), "div", message, "loading-card"));
		setStatus(message, true);
	} finally {
		refreshButton.disabled = false;
	}
}

refreshButton.addEventListener("click", loadCatalog);
loadCatalog();
