/**
 * Color palette for agent identity — ported from tangle/visual/palette.go.
 *
 * 12 color families × 12 shades = 144 unique agent addresses.
 * All shade names sourced from real color vocabulary.
 */

export interface PaletteColor {
	name: string;
	hex: string;
}

export interface Shade {
	name: string;
	colors: PaletteColor[];
}

export const PALETTE: Shade[] = [
	{
		name: "red",
		colors: [
			{ name: "crimson", hex: "#DC143C" },
			{ name: "scarlet", hex: "#FF2400" },
			{ name: "ruby", hex: "#E0115F" },
			{ name: "cardinal", hex: "#C41E3A" },
			{ name: "vermillion", hex: "#E34234" },
			{ name: "garnet", hex: "#733635" },
			{ name: "rosewood", hex: "#65000B" },
			{ name: "carmine", hex: "#960018" },
			{ name: "cinnabar", hex: "#E44D2E" },
			{ name: "claret", hex: "#7F1734" },
			{ name: "cordovan", hex: "#893F45" },
			{ name: "jasper", hex: "#D73B3E" },
		],
	},
	{
		name: "orange",
		colors: [
			{ name: "coral", hex: "#FF7F50" },
			{ name: "tangerine", hex: "#FF9966" },
			{ name: "amber", hex: "#FFBF00" },
			{ name: "apricot", hex: "#FBCEB1" },
			{ name: "flame", hex: "#E25822" },
			{ name: "persimmon", hex: "#EC5800" },
			{ name: "saffron", hex: "#F4C430" },
			{ name: "tawny", hex: "#CD5700" },
			{ name: "papaya", hex: "#FFEFD5" },
			{ name: "melon", hex: "#FEBAAD" },
			{ name: "marigold", hex: "#EAA221" },
			{ name: "pumpkin", hex: "#FF7518" },
		],
	},
	{
		name: "yellow",
		colors: [
			{ name: "gold", hex: "#FFD700" },
			{ name: "canary", hex: "#FFEF00" },
			{ name: "citrine", hex: "#E4D00A" },
			{ name: "ivory", hex: "#FFFFF0" },
			{ name: "mustard", hex: "#FFDB58" },
			{ name: "flax", hex: "#EEDC82" },
			{ name: "jasmine", hex: "#F8DE7E" },
			{ name: "champagne", hex: "#F7E7CE" },
			{ name: "cream", hex: "#FFFDD0" },
			{ name: "honey", hex: "#EB9605" },
			{ name: "straw", hex: "#E4D96F" },
			{ name: "buttercup", hex: "#F9E154" },
		],
	},
	{
		name: "green",
		colors: [
			{ name: "emerald", hex: "#50C878" },
			{ name: "jade", hex: "#00A86B" },
			{ name: "sage", hex: "#BCB88A" },
			{ name: "olive", hex: "#808000" },
			{ name: "fern", hex: "#4F7942" },
			{ name: "malachite", hex: "#0BDA51" },
			{ name: "pistachio", hex: "#93C572" },
			{ name: "viridian", hex: "#40826D" },
			{ name: "moss", hex: "#8A9A5B" },
			{ name: "mint", hex: "#3EB489" },
			{ name: "juniper", hex: "#3A5311" },
			{ name: "laurel", hex: "#A9BA9D" },
		],
	},
	{
		name: "cyan",
		colors: [
			{ name: "teal", hex: "#008080" },
			{ name: "turquoise", hex: "#40E0D0" },
			{ name: "aqua", hex: "#00FFFF" },
			{ name: "cerulean", hex: "#007BA7" },
			{ name: "capri", hex: "#00BFFF" },
			{ name: "celeste", hex: "#B2FFFF" },
			{ name: "keppel", hex: "#3AB09E" },
			{ name: "moonstone", hex: "#3AA8C1" },
			{ name: "lagoon", hex: "#017987" },
			{ name: "opal", hex: "#A8C3BC" },
			{ name: "seafoam", hex: "#93E9BE" },
			{ name: "frost", hex: "#A1CAF1" },
		],
	},
	{
		name: "blue",
		colors: [
			{ name: "azure", hex: "#007FFF" },
			{ name: "cobalt", hex: "#0047AB" },
			{ name: "sapphire", hex: "#0F52BA" },
			{ name: "navy", hex: "#000080" },
			{ name: "denim", hex: "#1560BD" },
			{ name: "indigo", hex: "#4B0082" },
			{ name: "lapis", hex: "#26619C" },
			{ name: "periwinkle", hex: "#CCCCFF" },
			{ name: "midnight", hex: "#191970" },
			{ name: "aegean", hex: "#1F456E" },
			{ name: "horizon", hex: "#5A86AD" },
			{ name: "glacier", hex: "#80B3C4" },
		],
	},
	{
		name: "violet",
		colors: [
			{ name: "amethyst", hex: "#9966CC" },
			{ name: "iris", hex: "#5A4FCF" },
			{ name: "lilac", hex: "#C8A2C8" },
			{ name: "orchid", hex: "#DA70D6" },
			{ name: "wisteria", hex: "#C9A0DC" },
			{ name: "heliotrope", hex: "#DF73FF" },
			{ name: "mauve", hex: "#E0B0FF" },
			{ name: "plum", hex: "#8E4585" },
			{ name: "thistle", hex: "#D8BFD8" },
			{ name: "lavender", hex: "#E6E6FA" },
			{ name: "mulberry", hex: "#C54B8C" },
			{ name: "byzantium", hex: "#702963" },
		],
	},
	{
		name: "pink",
		colors: [
			{ name: "rose", hex: "#FF007F" },
			{ name: "blush", hex: "#DE5D83" },
			{ name: "fuchsia", hex: "#FF00FF" },
			{ name: "salmon", hex: "#FA8072" },
			{ name: "peach", hex: "#FFCBA4" },
			{ name: "carnation", hex: "#FFA6C9" },
			{ name: "cerise", hex: "#DE3163" },
			{ name: "magenta", hex: "#FF0090" },
			{ name: "flamingo", hex: "#FC8EAC" },
			{ name: "petal", hex: "#F4C2C2" },
			{ name: "begonia", hex: "#FA6775" },
			{ name: "primrose", hex: "#F6E3CE" },
		],
	},
	{
		name: "brown",
		colors: [
			{ name: "umber", hex: "#635147" },
			{ name: "sienna", hex: "#A0522D" },
			{ name: "chestnut", hex: "#954535" },
			{ name: "bronze", hex: "#CD7F32" },
			{ name: "copper", hex: "#B87333" },
			{ name: "walnut", hex: "#773F1A" },
			{ name: "caramel", hex: "#FFD59A" },
			{ name: "mahogany", hex: "#C04000" },
			{ name: "cocoa", hex: "#D2691E" },
			{ name: "toffee", hex: "#755139" },
			{ name: "russet", hex: "#80461B" },
			{ name: "hickory", hex: "#674C47" },
		],
	},
	{
		name: "gray",
		colors: [
			{ name: "slate", hex: "#708090" },
			{ name: "ash", hex: "#B2BEB5" },
			{ name: "charcoal", hex: "#36454F" },
			{ name: "silver", hex: "#C0C0C0" },
			{ name: "gunmetal", hex: "#2A3439" },
			{ name: "iron", hex: "#48494B" },
			{ name: "steel", hex: "#71797E" },
			{ name: "pewter", hex: "#8E8E8E" },
			{ name: "flint", hex: "#6D6D6D" },
			{ name: "smoke", hex: "#738276" },
			{ name: "graphite", hex: "#383838" },
			{ name: "fossil", hex: "#787276" },
		],
	},
	{
		name: "white",
		colors: [
			{ name: "snow", hex: "#FFFAFA" },
			{ name: "pearl", hex: "#EAE0C8" },
			{ name: "alabaster", hex: "#F2F0E6" },
			{ name: "bone", hex: "#E3DAC9" },
			{ name: "linen", hex: "#FAF0E6" },
			{ name: "porcelain", hex: "#F0EAD6" },
			{ name: "eggshell", hex: "#F0EAD6" },
			{ name: "chalk", hex: "#FDFDFD" },
			{ name: "cloud", hex: "#F2F3F4" },
			{ name: "milk", hex: "#FDFFF5" },
			{ name: "cotton", hex: "#FBFBF9" },
			{ name: "marble", hex: "#F2F0EB" },
		],
	},
	{
		name: "black",
		colors: [
			{ name: "onyx", hex: "#353839" },
			{ name: "jet", hex: "#343434" },
			{ name: "ebony", hex: "#555D50" },
			{ name: "obsidian", hex: "#3C3C3C" },
			{ name: "raven", hex: "#0E0E10" },
			{ name: "coal", hex: "#3B3C36" },
			{ name: "sable", hex: "#3B3B3B" },
			{ name: "shadow", hex: "#292929" },
			{ name: "ink", hex: "#1B1B1B" },
			{ name: "pitch", hex: "#1C1C1C" },
			{ name: "void", hex: "#0A0A0A" },
			{ name: "phantom", hex: "#1A1A2E" },
		],
	},
];

/** Total unique colors in the palette */
export const PALETTE_SIZE = PALETTE.reduce((sum, shade) => sum + shade.colors.length, 0);
