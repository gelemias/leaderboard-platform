import type { RunSubmission } from "../validation/run";

const allowedPowerUps = new Set([
	"shield",
	"double_gum",
	"golden_treat",
	"counter_treat",
	"slow_teeth",
	"clear_teeth",
	"freeze_teeth",
]);

function count(values: Record<string, number>, key: string): number {
	return values[key] ?? 0;
}

export function validateRunSubmission(run: RunSubmission): string | null {
	if (run.run_mode !== "normal") return "Only normal runs may be submitted";
	if (run.score < 1 || run.jumps < 1) return "Score and jumps must be positive";
	if (run.score < run.jumps) return "Score cannot be lower than jumps";
	if (run.near_misses > run.jumps) return "Near misses cannot exceed jumps";
	if (run.highest_combo > 8) return "Highest combo exceeds the supported limit";
	if (run.highest_combo > run.near_misses + 1) return "Highest combo is inconsistent with near misses";

	const collected = run.power_up_collection_counts;
	const activated = run.power_up_activation_counts;
	for (const key of [...Object.keys(collected), ...Object.keys(activated), ...run.power_up_types_collected]) {
		if (!allowedPowerUps.has(key)) return `Unknown power-up: ${key}`;
	}
	if (new Set(run.power_up_types_collected).size !== run.power_up_types_collected.length) {
		return "Power-up types must be unique";
	}
	for (const key of allowedPowerUps) {
		const collectionCount = count(collected, key);
		const activationCount = count(activated, key);
		if (activationCount > collectionCount) return `Activations exceed collections for ${key}`;
		if ((collectionCount > 0) !== run.power_up_types_collected.includes(key)) {
			return `Power-up type list is inconsistent for ${key}`;
		}
	}

	if (run.shield_breaks > count(activated, "shield")) return "Shield breaks exceed activations";
	if (run.double_gum_boosted_jumps > run.jumps) return "Boosted jumps exceed total jumps";
	if (run.double_gum_boosted_jumps > count(activated, "double_gum") * 5) {
		return "Boosted jumps exceed Double Gum activations";
	}
	if (run.jump_score_points < run.jumps || run.jump_score_points > run.jumps * run.highest_combo) {
		return "Jump score points are inconsistent";
	}
	if (
		run.double_gum_bonus_points < run.double_gum_boosted_jumps ||
		run.double_gum_bonus_points > run.double_gum_boosted_jumps * run.highest_combo
	) {
		return "Double Gum bonus points are inconsistent";
	}
	if (run.golden_treat_bonus_points !== count(collected, "golden_treat") * 5) {
		return "Golden Treat bonus points are inconsistent";
	}
	if (
		run.score !==
		run.jump_score_points + run.double_gum_bonus_points + run.golden_treat_bonus_points
	) {
		return "Score does not equal its component points";
	}

	return null;
}
