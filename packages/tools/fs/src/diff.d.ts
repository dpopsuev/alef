declare module "diff" {
	interface Change {
		count?: number;
		added?: boolean;
		removed?: boolean;
		value: string;
	}
	export function diffLines(oldStr: string, newStr: string): Change[];
}
