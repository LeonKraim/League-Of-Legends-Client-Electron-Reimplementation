import { vof } from '@danor-lib/error';



const globalTop = globalThis ?? global;


const parseEnvironments = (env) => {
	/** @type {Object<string, string>} */
	const environments = {};

	try {
		const entries = [...new globalTop.URL(`https://world.peace?${env ?? ''}`).searchParams.entries()];

		for(const [key, value] of entries) { environments[key.toLowerCase()] = value; }
	}
	catch { void 0; }

	return environments;
};

const envHades = parseEnvironments(process.env?.DRENV_HADES);

const willStyle = envHades.style == 'true';
const isModeDynamic = envHades.modeStyle == 'dynamic';



const texterStill = {
	invalidStructChar: (value) => `each character of struct argument must be one of xscfdbhilqBHILQ, value ${vof(value)}`,
	invalidConstructorRaw: (value) => `raw argument must be one of type string, number or an instance of Buffer, value ${vof(value)}`,
	invalidCursor: (value) => `cursor argument must be of type number, value ${vof(value)}`,
	invalidSzie: (value) => `size argument must be of type number, value ${vof(value)}`,
	invalidOptions: (value) => `options argument must be of type object, value ${vof(value)}`,
};
const texterStyle = {
	invalidStructChar: (value) => `each character of ~[struct] argument must be one of ~{xscfdbhilqBHILQ}, value ~{${vof(value)}}`,
	invalidConstructorRaw: (value) => `~[raw] argument must be one of type ~{string}, ~{number} or an instance of ~{Buffer}, value ~{${vof(value)}}`,
	invalidCursor: (value) => `~[cursor] argument must be of type ~{number}, value ~{${vof(value)}}`,
	invalidSzie: (value) => `~[size] argument must be of type ~{number}, value ~{${vof(value)}}`,
	invalidOptions: (value) => `~[options] argument must be of type ~{object}, value ~{${vof(value)}}`,
};



export const T = !isModeDynamic
	? willStyle ? texterStyle : texterStill
	: Object.fromEntries(Object.keys(texterStyle)
		.map(key => (...args) => (parseEnvironments(process.env?.DRENV_HADES)?.style == 'true' ? texterStyle : texterStill)[key]?.(...args)));
