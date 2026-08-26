import { replayValidatorRegistry } from "./replay-registry";
import { CloudHopperReferenceValidator } from "./simulators/cloud-hopper-reference";
import { JumpyChewieHttpValidator } from "./simulators/jumpy-chewie-http";

// Every production adapter is registered with an exact ruleset and build key.
replayValidatorRegistry.register(
	"game-cloud-hopper",
	"cloud-hopper-1",
	"reference-1",
	new CloudHopperReferenceValidator(),
);

// The production Worker can delegate the Godot replay to a separately
// deployed, exact-build simulator service. The adapter uses trusted mode when
// its URL is absent and fails closed when a configured simulator is unavailable.
replayValidatorRegistry.register(
	"game-jumpy-chewie",
	"jumpy-chewie-2",
	"0.1.0",
	new JumpyChewieHttpValidator(),
);
replayValidatorRegistry.register(
	"game-jumpy-chewie",
	"jumpy-chewie-3",
	"0.1.0",
	new JumpyChewieHttpValidator(),
);
