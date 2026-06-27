export {
	createEnclosureAdapter,
	createEnclosureAdapter as createAdapter,
	type EnclosureAdapterOptions,
} from "./adapter.js";
export { DockerSpace, type DockerSpaceOptions } from "./docker-space.js";
export {
	type Change,
	type ChangeKind,
	type ExecOptions,
	type ExecResult,
	OverlaySpace,
	type Space,
	type SpaceOptions,
	StubSpace,
} from "./space.js";
export { service } from "./service.js";
