export default class Biffer {
	/** Sizes (in bytes) of each struct character type. */
	static sizes$charStruct: {
		x: number;

		s: number;
		c: number;

		b: number;
		B: number;

		h: number;
		H: number;

		i: number;
		I: number;

		l: number;
		L: number;

		q: number;
		Q: number;

		f: number;
		d: number;
	};


	/**
	 * @param {string[]} chars Struct characters array.
	 * @returns {['LE'|'BE', boolean]} The endianness and a boolean indicating if an endian specifier was present.
	 */
	static #parseEndian(chars: string[]): ["LE" | "BE", boolean];

	/**
	 * @param {string} stringCountChar A string like "4i" or "c".
	 * @returns {[string, number, number]} [charType, count, sizeInBytes]
	 */
	static #parseStructChar(stringCountChar: string): [string, number, number];

	/**
	 * @param {string} struct Format string (e.g., ">4i2s").
	 * @param {Buffer} buffer The buffer to unpack from.
	 * @param {number} [cursor=0] Starting position in buffer.
	 * @returns {[(number|bigint|string)[], number]} [unpackedData, bytesRead]
	 */
	static unpack(struct: string, buffer: Buffer, cursor?: number): [(number | bigint | string)[], number];
	/**
	 * Calculates the total size in bytes of the given struct format.
	 *
	 * @param {string} struct Format string.
	 * @returns {number} Total size in bytes.
	 */
	static calc(struct: string): number;


	/**
	 * A convenient wrapper around Node.js Buffer with file descriptor support.
	 * @param {Biffer|Buffer|string|number} raw A Biffer instance, Buffer, file descriptor, or file path.
	 */
	constructor(raw: Biffer | Buffer | string | number);


	/**
	 * The underlying buffer or file descriptor.
	 * @type {Buffer|number}
	 */
	get target(): Buffer | number;

	/**
	 * File path if constructed from a file path.
	 * @type {String}
	 */
	path: string;

	/**
	 * Current read/write position (in bytes).
	 * @type {number}
	 */
	get cursor(): number;

	/**
	 * Total length (in bytes) of the target.
	 * @type {number}
	 */
	get length(): number;

	/**
	 * Indicates whether Biffer is using a file descriptor.
	 * @type {number}
	 */
	get usingFileDescriptor(): number;


	/**
	 * Creates a clone of this Biffer instance.
	 * @returns {Biffer}
	 */
	clone(): Biffer;


	/**
	 * Unpack data according to the struct format string.
	 * - For the characters `B`, `H`, `I`, `L`, and `Q`, their lowercase versions correspond to the signed versions.
	 * - The **endian** char only works at the **beginning** of the string.
	 *
	 * | char | size | meaning                 |
	 * | :--- | :--- | :---------------------  |
	 * | <    | -    | little endian (default) |
	 * | >    | -    | big endian              |
	 * | x    | 1    | padding                 |
	 * | s    | 1    | varying string          |
	 * | c    | 1    | char                    |
	 * | f    | 4    | float                   |
	 * | d    | 8    | double                  |
	 * | B    | 1    | char (unsigned)         |
	 * | H    | 2    | short int (unsigned)    |
	 * | I    | 4    | int (unsigned)          |
	 * | L    | 4    | long int (unsigned)     |
	 * | Q    | 8    | quad int (unsigned)     |
	 *
	 * @param {string} struct Format string describing the structure.
	 * @returns {(number|bigint|string)[]}
	 */
	unpack(struct: string): (number | bigint | string)[];


	/**
	 * Returns the current cursor position.
	 * @returns {number}
	 */
	tell(): number;
	/**
	 * Moves the cursor to a new position.
	 * @param {number} cursor The new position.
	 * @returns {number} The new cursor position.
	 */
	seek(cursor: number): number;
	/**
	 * Moves the cursor by the specified offset (negative values allowed).
	 * @param {number} size Offset to move by.
	 * @returns {number} The new cursor position.
	 */
	skip(size: number): number;

	/**
	 * Extracts a slice of the buffer starting from the current cursor position.
	 * @param {number} size Number of bytes to slice.
	 * @param {Object} options Options object.
	 * @param {boolean} options.wrap If true, returns a Biffer instance; otherwise returns a raw Buffer.
	 * @param {boolean} options.seek If true, advances the cursor by the slice size.
	 * @returns {Biffer|Buffer}
	 */
	slice(size: number, options: {
		wrap: boolean;
		seek: boolean;
	}): Biffer | Buffer;

	/**
	 * Finds the first occurrence of the given data in the buffer starting from the current cursor.
	 * @param {any} data Data to search for (will be passed to `Buffer.from`).
	 * @returns {number} The offset of the first occurrence, or -1 if not found.
	 */
	find(data: any): number;
	/**
	 * Seeks to the beginning and then finds the first occurrence of the given data.
	 * @param {any} data Data to search for (will be passed to `Buffer.from`).
	 * @returns {number} The offset of the first occurrence, or -1 if not found.
	 */
	findFromHead(data: any): number;

	/**
	 * Unpacks a string that is prefixed by its length (length field + string data).
	 * @param {string} charLength The struct character for the length field (default is `'L'`).
	 * @param {boolean} returnBuffer If true, returns a Buffer; otherwise returns a string (default is false).
	 * @returns {string|Buffer}
	 */
	unpackString(charLength?: string, returnBuffer?: boolean): string | Buffer;

	/**
	 * Checks if the cursor has reached or passed the end of the data.
	 * @returns {boolean}
	 */
	isReach(): boolean;

	/**
	 * Closes the underlying file descriptor if it is open.
	 */
	close(): void;

	#private;
}
