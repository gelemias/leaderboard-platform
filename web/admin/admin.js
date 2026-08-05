const root = document.querySelector("#admin-root");
const loginForm = document.querySelector("#login-form");
const loginToken = document.querySelector("#login-token");
const loginButton = document.querySelector("#login");
const loginStatus = document.querySelector("#login-status");

loginForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	const accessToken = loginToken.value.trim();
	if (!accessToken) return;
	loginButton.disabled = true;
	loginStatus.className = "hint";
	loginStatus.textContent = "Checking…";
	try {
		const response = await fetch("/v1/admin/session", {
			headers: { Authorization: `Bearer ${accessToken}` },
			cache: "no-store",
		});
		if (!response.ok) throw new Error("Sign-in failed");
		renderComposer(accessToken);
	} catch {
		loginStatus.className = "error";
		loginStatus.textContent = "Sign-in failed. Check the token and try again.";
		loginButton.disabled = false;
	}
});

function renderComposer(accessToken) {
	root.innerHTML = `
		<section class="card">
			<h1>Leaderboard notifications</h1>
			<p>Queue a message for opted-in players. Target individual players or send to everyone who enabled administrator messages.</p>
			<form id="campaign-form">
				<div class="target-toolbar">
					<label>Game<select id="game" required><option value="">Loading games…</option></select></label>
					<button class="secondary" id="load-players" type="button">Load players</button>
				</div>
				<label>Title<input id="title" maxlength="120" required /></label>
				<label>Message<textarea id="body" maxlength="2000" required></textarea></label>
				<label>Audience<select id="audience"><option value="all_opted_in">All opted-in players</option><option value="player_ids">Specific players</option></select></label>
				<section id="target-picker" hidden>
					<div class="target-toolbar">
						<label>Find players<input id="player-search" placeholder="Search by name or player ID" /></label>
						<button class="secondary" id="search-players" type="button">Search</button>
					</div>
					<p class="hint">Only players with an active installation and both notification preferences enabled can receive the message.</p>
					<div id="player-list" class="player-list"><div class="player-empty">Load players to choose recipients.</div></div>
					<p id="target-summary" class="target-summary">0 players selected</p>
				</section>
				<button id="send" type="submit">Queue notification</button>
			</form>
			<p id="status" class="hint" role="status"></p>
		</section>`;

	const form = document.querySelector("#campaign-form");
	const game = document.querySelector("#game");
	const audience = document.querySelector("#audience");
	const targetPicker = document.querySelector("#target-picker");
	const playerSearch = document.querySelector("#player-search");
	const playerList = document.querySelector("#player-list");
	const targetSummary = document.querySelector("#target-summary");
	const loadPlayersButton = document.querySelector("#load-players");
	const searchPlayersButton = document.querySelector("#search-players");
	const status = document.querySelector("#status");
	const send = document.querySelector("#send");
	let players = [];
	const selectedPlayerIds = new Set();

	function showStatus(message, kind = "hint") {
		status.className = kind;
		status.textContent = message;
	}

	function updateTargetSummary() {
		const eligibleSelected = players.filter(
			(player) => selectedPlayerIds.has(player.player_id) && player.eligible_installation_count > 0,
		).length;
		targetSummary.textContent = `${selectedPlayerIds.size} player(s) selected; ${eligibleSelected} currently eligible to receive`;
	}

	function renderPlayers() {
		playerList.replaceChildren();
		if (players.length === 0) {
			const empty = document.createElement("div");
			empty.className = "player-empty";
			empty.textContent = "No players found.";
			playerList.append(empty);
			updateTargetSummary();
			return;
		}

		for (const player of players) {
			const row = document.createElement("div");
			row.className = "player-option";
			const recipient = document.createElement("label");
			recipient.className = "player-recipient";
			const checkbox = document.createElement("input");
			checkbox.type = "checkbox";
			checkbox.checked = selectedPlayerIds.has(player.player_id);
			checkbox.disabled = player.eligible_installation_count === 0;
			checkbox.addEventListener("change", () => {
				if (checkbox.checked) selectedPlayerIds.add(player.player_id);
				else selectedPlayerIds.delete(player.player_id);
				updateTargetSummary();
			});
			const copy = document.createElement("span");
			copy.className = "player-copy";
			const name = document.createElement("span");
			name.className = "player-name";
			name.textContent = player.display_name;
			const meta = document.createElement("span");
			meta.className = "player-meta";
			meta.textContent = player.eligible_installation_count > 0
				? `${player.player_id} · ${player.eligible_installation_count} eligible installation(s)`
				: `${player.player_id} · no opted-in installation`;
			copy.append(name, meta);
			recipient.append(checkbox, copy);
			const remove = document.createElement("button");
			remove.className = "remove-player";
			remove.type = "button";
			remove.textContent = "Remove";
			remove.title = "Permanently remove this player from this game";
			remove.addEventListener("click", () => removePlayer(player, remove));
			row.append(recipient, remove);
			playerList.append(row);
		}
		updateTargetSummary();
	}

	async function removePlayer(player, removeButton) {
		if (!window.confirm(`Remove ${player.display_name} (${player.player_id}) from this game? This deletes their leaderboard data, runs, tokens, and push installations.`)) return;
		const typedId = window.prompt(`Type the player ID to confirm removal:\n${player.player_id}`);
		if (typedId !== player.player_id) {
			showStatus("Removal cancelled: player ID did not match.", "error");
			return;
		}
		removeButton.disabled = true;
		try {
			const response = await fetch(`/v1/admin/games/${encodeURIComponent(game.value.trim())}/players/${encodeURIComponent(player.player_id)}`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${accessToken}` },
			});
			const result = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(result?.error?.message || `Removal failed (${response.status})`);
			selectedPlayerIds.delete(player.player_id);
			players = players.filter((candidate) => candidate.player_id !== player.player_id);
			renderPlayers();
			showStatus(`${player.display_name} was removed from this game.`, "success");
		} catch (error) {
			showStatus(error instanceof Error ? error.message : "Unable to remove player", "error");
			removeButton.disabled = false;
		}
	}

	async function loadPlayers() {
		if (!game.value.trim()) {
			showStatus("Select a game first.", "error");
			game.focus();
			return;
		}
		loadPlayersButton.disabled = true;
		searchPlayersButton.disabled = true;
		playerList.replaceChildren();
		const loading = document.createElement("div");
		loading.className = "player-empty";
		loading.textContent = "Loading players…";
		playerList.append(loading);
		try {
			const params = new URLSearchParams({ limit: "200" });
			if (playerSearch.value.trim()) params.set("search", playerSearch.value.trim());
			const response = await fetch(`/v1/admin/games/${encodeURIComponent(game.value.trim())}/players?${params}`, {
				headers: { Authorization: `Bearer ${accessToken}` },
				cache: "no-store",
			});
			const result = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(result?.error?.message || `Unable to load players (${response.status})`);
			players = result.players ?? [];
			for (const selectedId of selectedPlayerIds) {
				if (!players.some((player) => player.player_id === selectedId)) selectedPlayerIds.delete(selectedId);
			}
			renderPlayers();
			showStatus(`${players.length} player(s) loaded.`, "hint");
		} catch (error) {
			players = [];
			renderPlayers();
			showStatus(error instanceof Error ? error.message : "Unable to load players", "error");
		} finally {
			loadPlayersButton.disabled = false;
			searchPlayersButton.disabled = false;
		}
	}

	async function loadGames() {
		game.disabled = true;
		loadPlayersButton.disabled = true;
		try {
			const response = await fetch("/v1/admin/games", {
				headers: { Authorization: `Bearer ${accessToken}` },
				cache: "no-store",
			});
			const result = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(result?.error?.message || `Unable to load games (${response.status})`);
			game.replaceChildren();
			for (const item of result.games ?? []) {
				const option = document.createElement("option");
				option.value = item.slug;
				option.textContent = `${item.name} (${item.slug})`;
				game.append(option);
			}
			if (game.options.length === 0) {
				const option = document.createElement("option");
				option.value = "";
				option.textContent = "No active games available";
				game.append(option);
				showStatus("No active games are available.", "error");
			} else {
				loadPlayersButton.disabled = false;
				showStatus("Select a game to continue.", "hint");
			}
		} catch (error) {
			game.replaceChildren();
			const option = document.createElement("option");
			option.value = "";
			option.textContent = "Unable to load games";
			game.append(option);
			showStatus(error instanceof Error ? error.message : "Unable to load games", "error");
		} finally {
			game.disabled = false;
		}
	}

	audience.addEventListener("change", () => {
		targetPicker.hidden = audience.value !== "player_ids";
		if (audience.value === "player_ids" && players.length === 0) loadPlayers();
	});
	loadPlayersButton.addEventListener("click", loadPlayers);
	searchPlayersButton.addEventListener("click", loadPlayers);
	game.addEventListener("change", () => {
		selectedPlayerIds.clear();
		players = [];
		if (!targetPicker.hidden) renderPlayers();
	});
	playerSearch.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			loadPlayers();
		}
	});

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		showStatus("Queueing…");
		send.disabled = true;
		const playerIds = [...selectedPlayerIds];
		if (audience.value === "player_ids" && playerIds.length === 0) {
			showStatus("Select at least one target player.", "error");
			send.disabled = false;
			return;
		}
		const payload = {
			title: document.querySelector("#title").value.trim(),
			body: document.querySelector("#body").value.trim(),
			audience: audience.value,
			...(audience.value === "player_ids" ? { player_ids: playerIds } : {}),
		};
		try {
			const response = await fetch(`/v1/admin/games/${encodeURIComponent(game.value.trim())}/notifications/campaigns`, {
				method: "POST",
				headers: { Authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			const result = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(result?.error?.message || `Request failed (${response.status})`);
			showStatus(`Campaign ${result.campaign_id} queued for ${result.recipients} installation(s).`, "success");
		} catch (error) {
			showStatus(error instanceof Error ? error.message : "Unable to queue campaign", "error");
		} finally {
			send.disabled = false;
		}
	});

	loadGames();
}
