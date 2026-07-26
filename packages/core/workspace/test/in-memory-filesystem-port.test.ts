import { InMemoryFilesystemPort } from "./in-memory-filesystem-port.js";
import { filesystemPortConformanceSuite } from "./filesystem-port-conformance.js";

filesystemPortConformanceSuite(() => new InMemoryFilesystemPort());
