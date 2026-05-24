import type { RichErrorOption } from '../types.d.ts';



export class RichError extends Error {
	/**
	 * @param {string} [message] A human-readable description of the error
	 * @param {RichErrorOption} [options]
	 */
	constructor(message?: string, options?: RichErrorOption);


	/** A lower-case slug string that identifies the specific error type or category */
	code?: string;
	/** A approximate location string where the error originated */
	at?: string;
	/** Additional contextual data associated with the error occurrence */
	data?: unknown;
	/** A boolean flag indicating whether the error is internal and should not be exposed to end users */
	internal?: boolean;


	/** Return the first error in the error chain based on the `cause` property */
	get root(): Error;
}

/** Return a value type-identifier string. */
export function RichError(message?: string, options?: RichErrorOption): RichError;
