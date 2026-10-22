// Hand-derived public registration contracts, NOT imported from implementation.
export const entriesByName = {
	"pi-ui": "./dist/pi-ui.js",
};
export const names = Object.keys(entriesByName);
export const releaseEntries = names.map((name) => `./extensions/${name}/${entriesByName[name].slice(2)}`);
export const toolsByName = {
	"pi-ui": [],
};
export const commandsByName = {
	"pi-ui": ["ccstyle"],
};
