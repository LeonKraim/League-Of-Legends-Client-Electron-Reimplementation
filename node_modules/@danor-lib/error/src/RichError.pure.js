/** @import { RichErrorOption } from '../types.ts' */



/** Internal RichError */
export class InternalRichError extends Error {
	/**
	 * @param {string} [message] A human-readable description of the error
	 * @param {RichErrorOption} [options]
	 */
	constructor(message, options = {}) {
		super(message, 'cause' in options ? { cause: options.cause } : {});

		this.name = 'RichError';
		this.stack = this.stack?.replace(/^\s*?at( new)? RichError \(.*?$\n/m, '');

		if('code' in options) { this.code = options.code; }
		if('at' in options) { this.at = options.at; }
		if('data' in options) { this.data = options.data; }
		if('internal' in options) { this.internal = options.internal; }
	}

	/** @returns {Error} */
	get root() {
		let errorRoot = this;

		while(errorRoot?.cause instanceof Error) {
			errorRoot = errorRoot.cause;
		}

		return errorRoot;
	}
}



/**
 * @param {string} [message] A human-readable description of the error
 * @param {RichErrorOption} [options]
 * @returns {RichError}
 */
export const RichError = function(message, options) {
	const thisNew = new InternalRichError(message, options);
	Object.setPrototypeOf(thisNew, RichError.prototype);

	// patch when class extends
	if(this?.__proto__ && this?.__proto__ !== RichError.prototype) {
		Object.setPrototypeOf(thisNew, this?.__proto__);

		const nameOld = thisNew.name;

		thisNew.name = this.constructor.name;
		thisNew.stack = thisNew.stack
			?.replace(new RegExp(`^${nameOld}`), this.constructor.name)
			?.replace(new RegExp(`^\\s*?at( new)? ${this.constructor.name} \\(.*?$\\n`, 'm'), '');
	}

	return thisNew;
};

Object.setPrototypeOf(RichError.prototype, InternalRichError.prototype);
