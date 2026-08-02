import { replayValidatorRegistry } from "./replay-registry";
import { CloudHopperReferenceValidator } from "./simulators/cloud-hopper-reference";

// This is the only fully specified simulator currently shipped. Production
// game adapters must be registered with an exact ruleset and build key.
replayValidatorRegistry.register(
	"game-cloud-hopper",
	"cloud-hopper-1",
	"reference-1",
	new CloudHopperReferenceValidator(),
);
