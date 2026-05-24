/**
 * Return a value type-identifier string.
 * @param {unknown} value
 * @returns {string}
 */
export const vof = value => {
	if(value === '') { return `<is:empty-string>`; }
	else if(value === null) { return `<is:null>`; }
	else if(value === undefined) { return `<is:undefined>`; }


	const type = typeof value;

	if(type == 'string') { return `${value} <is:string(${value.length})>`; }

	if(type == 'function') { return `function ${value.name || '(anonymous)'} <is:function>`; }

	if(type == 'number') {
		if(Number.isNaN(value)) { return `<is:NaN>`; }
		if(!Number.isFinite(value)) { return `<is:${value > 0 ? 'Infinity' : '-Infinity'}>`; }
		if(Object.is(value, -0)) { return `-0 <is:number>`; }

		return `${value} <is:number>`;
	}

	if(type == 'object') {
		if(Array.isArray(value)) { return `${value} <is:Array(${value.length})>`; }

		try {
			return `${JSON.stringify(value)} <is:object>`;
		}
		catch {
			return `<bad-stringify object>`;
		}
	}


	return `${value} <is:${type}>`;
};
