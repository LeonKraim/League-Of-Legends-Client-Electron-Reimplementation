import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { inspect } from 'node:util';

import { RichError } from '@danor-lib/error';

import { T } from './src/texter.js';



export default class Biffer {
	/** Sizes (in bytes) of each struct character type. */
	static sizes$charStruct = {
		x: 1, // padding

		s: 1, // varying string
		c: 1, // char

		b: 1, // signed char
		B: 1, // unsigned char

		h: 2, // signed short
		H: 2, // unsigned short

		i: 4, // signed int
		I: 4, // unsigned int

		l: 4, // signed long
		L: 4, // unsigned long

		q: 8, // signed long
		Q: 8, // unsigned long

		f: 4, // float
		d: 8, // double
	};

	/**
	 * @param {string[]} chars Struct characters array.
	 * @returns {['LE'|'BE', boolean]} The endianness and a boolean indicating if an endian specifier was present.
	 */
	static #parseEndian(chars) {
		const char = chars[0];

		return [
			char == '>' ? 'BE' : 'LE',
			char == '>' || char == '<',
		];
	}

	/**
	 * @param {string} stringCountChar A string like "4i" or "c".
	 * @returns {[string, number, number]} [charType, count, sizeInBytes]
	 */
	static #parseStructChar(stringCountChar) {
		let [count, char] = stringCountChar.split(/(?=[A-Za-z])/);

		if(!char) {
			char = count;

			count = 1;
		}

		return [char, ~~count, Biffer.sizes$charStruct[char]];
	}

	/**
	 * @param {string} struct Format string (e.g., ">4i2s").
	 * @param {Buffer} buffer The buffer to unpack from.
	 * @param {number} [cursor=0] Starting position in buffer.
	 * @returns {[(number|bigint|string)[], number]} [unpackedData, bytesRead]
	 */
	static unpack(struct, buffer, cursor = 0) {
		const positionFirst = cursor;

		const chars = struct.match(/(^[<>])|\d*[a-zA-Z]/g);

		const [endian, isMatchEndian] = Biffer.#parseEndian(chars);
		if(isMatchEndian) { chars.shift(); }


		const dataRead = [];
		chars.forEach((charRaw, indexChar) => {
			const [charType, count, sizeType] = Biffer.#parseStructChar(charRaw);

			// varying string
			if(charType == 's') {
				dataRead.push(
					buffer.toString('utf8', cursor, cursor + count)
				);
			}
			// char
			else if(charType == 'c') {
				let remain = count;

				while(remain > 0) {
					dataRead.push(
						String.fromCharCode(buffer[cursor + sizeType * (count - remain--)])
					);
				}
			}
			// integer
			else if(/[bhilq]/i.test(charType)) {
				const signed = /[bhilq]/.test(charType) ? '' : 'U';
				const big = sizeType > 4 ? 'Big' : '';
				const sizeBytes = sizeType * 8;
				const markEndian = sizeType > 1 ? endian : '';


				let remain = count;

				while(remain > 0) {
					dataRead.push(
						buffer[`read${big}${signed}Int${sizeBytes}${markEndian}`](cursor + sizeType * (count - remain--))
					);
				}
			}
			// float, double
			else if(/[fd]/.test(charType)) {
				const type = 'f' == charType ? 'Float' : 'Double';
				const markEndian = sizeType > 1 ? endian : '';


				let remain = count;
				while(remain > 0) {
					dataRead.push(
						buffer[`read${type}${markEndian}`](cursor + sizeType * (count - remain--))
					);
				}
			}
			// padding
			else if(charType != 'x') {
				throw RichError(T.invalidStructChar(charType), {
					code: 'invalid-struct-char', at: 'Biffer.unpack',
					data: { char: charType, indexChar, chars, struct },
				});
			}


			cursor += sizeType * count;
		});

		return [dataRead, cursor - positionFirst];
	}

	/**
	 * Calculates the total size in bytes of the given struct format.
	 *
	 * @param {string} struct Format string.
	 * @returns {number} Total size in bytes.
	 */
	static calc(struct) {
		const chars = struct.match(/(^[<>])|\d*[a-zA-Z]/g);

		const [, isMatchEndian] = Biffer.#parseEndian(chars);

		if(isMatchEndian) { chars.shift(); }

		let length = 0;

		chars.forEach((charRaw, indexChar) => {
			const [char, count] = Biffer.#parseStructChar(charRaw);

			const len = Biffer.sizes$charStruct[char];

			if(!len) {
				throw RichError(T.invalidStructChar(char), {
					code: 'invalid-struct-char', at: 'Biffer.calc',
					data: { char, indexChar, chars, struct },
				});
			}
			else {
				length += len * (~~count || 4);
			}
		});

		return length;
	}



	/**
	 * The underlying buffer or file descriptor.
	 * @type {Buffer|number}
	 */
	#target;
	/**
	 * The underlying buffer or file descriptor.
	 * @type {Buffer|number}
	 */
	get target() { return this.#target; }

	/**
	 * File path if constructed from a file path.
	 * @type {String}
	 */
	path;

	/**
	 * Current read/write position (in bytes).
	 * @type {number}
	 */
	#cursor = 0;
	/**
	 * Current read/write position (in bytes).
	 * @type {number}
	 */
	get cursor() { return this.#cursor; }

	/**
	 * Total length (in bytes) of the target.
	 * @type {number}
	 */
	#length;
	/**
	 * Total length (in bytes) of the target.
	 * @type {number}
	 */
	get length() { return this.#length; }

	/**
	 * Indicates whether Biffer is using a file descriptor.
	 * @type {boolean}
	 */
	#usingFileDescriptor = false;
	/**
	 * Indicates whether Biffer is using a file descriptor.
	 * @type {boolean}
	 */
	get usingFileDescriptor() { return this.#usingFileDescriptor; }



	/**
	 * A convenient wrapper around Node.js Buffer with file descriptor support.
	 * @param {Biffer|Buffer|string|number} raw A Biffer instance, Buffer, file descriptor, or file path.
	 */
	constructor(raw) {
		if(raw instanceof Biffer) {
			raw = raw.path || raw.target;
		}

		if(raw instanceof Buffer) {
			this.#target = raw;
		}
		else if(typeof raw == 'number') {
			this.#target = raw;

			this.#usingFileDescriptor = true;
		}
		else if(typeof raw == 'string') {
			this.#target = openSync(raw);

			this.#usingFileDescriptor = true;

			this.path = raw;
		}
		else {
			throw RichError(T.invalidConstructorRaw(raw), {
				code: 'invalid-constructor-raw', at: 'Biffer.constructor',
				data: raw,
			});
		}


		this.#length = this.usingFileDescriptor ?
			fstatSync(this.#target).size :
			this.#target.length;
	}


	/**
	 * Creates a clone of this Biffer instance.
	 * @returns {Biffer}
	 */
	clone() {
		return new Biffer(this);
	}


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
	unpack(struct) {
		const sizeData = Biffer.calc(struct);

		let buffer = this.target;
		if(this.usingFileDescriptor) {
			readSync(this.target, buffer = Buffer.alloc(sizeData), 0, sizeData, this.cursor);
		}

		const [data, byteRead] = Biffer.unpack(struct, buffer, this.usingFileDescriptor ? 0 : this.cursor);

		this.#cursor += byteRead;

		return data;
	}


	/**
	 * Returns the current cursor position.
	 * @returns {number}
	 */
	tell() {
		return this.cursor;
	}
	/**
	 * Moves the cursor to a new position.
	 * @param {number} cursor The new position.
	 * @returns {number} The new cursor position.
	 */
	seek(cursor) {
		if(typeof cursor != 'number') {
			throw RichError(T.invalidCursor(cursor), {
				code: 'invalid-seek-position', at: 'Biffer#seek',
				data: { position: cursor, biffer: this },
			});
		}

		return this.#cursor = cursor;
	}
	/**
	 * Moves the cursor by the specified offset (negative values allowed).
	 * @param {number} size Offset to move by.
	 * @returns {number} The new cursor position.
	 */
	skip(size) {
		if(typeof size != 'number') {
			throw RichError(T.invalidSzie(size), {
				code: 'invalid-skip-offset', at: 'Biffer#skip',
				data: { offset: size, biffer: this },
			});
		}

		return this.#cursor += size;
	}

	/**
	 * Extracts a slice of the buffer starting from the current cursor position.
	 * @param {number} size Number of bytes to slice.
	 * @param {Object} options Options object.
	 * @param {boolean} options.wrap If true, returns a Biffer instance; otherwise returns a raw Buffer.
	 * @param {boolean} options.seek If true, advances the cursor by the slice size.
	 * @returns {Biffer|Buffer}
	 */
	slice(size, options) {
		if(typeof size != 'number') {
			throw RichError(T.invalidSzie(size), {
				code: 'invalid-slice-size', at: 'Biffer#slice(1:size)',
				data: { size, biffer: this },
			});
		}
		if(options && typeof options != 'object') {
			throw RichError(T.invalidOptions(options), {
				code: 'invalid-slice-options', at: 'Biffer#slice(2:options)',
				data: { options, biffer: this },
			});
		}


		const willWrap = options && 'wrap' in options && options.wrap !== undefined ? Boolean(options.wrap) : true;
		const willSeek = options && 'seek' in options && options.seek !== undefined ? Boolean(options.seek) : true;


		const dead = this.cursor + size;

		const buffer = this.usingFileDescriptor ?
			Buffer.alloc(size) :
			this.target.subarray(this.cursor, dead);

		if(this.usingFileDescriptor) {
			readSync(this.target, buffer, 0, size, this.cursor);
		}


		if(willSeek) {
			this.#cursor = dead;
		}


		return willWrap ? new Biffer(buffer) : buffer;
	}


	/**
	 * Finds the first occurrence of the given data in the buffer starting from the current cursor.
	 * @param {any} data Data to search for (will be passed to `Buffer.from`).
	 * @returns {number} The offset of the first occurrence, or -1 if not found.
	 */
	find(data) {
		const bufferData = Buffer.from(data);

		let offset = -1;

		if(this.usingFileDescriptor) {
			const buffer = Buffer.alloc(1024 * 1024 + bufferData.length);
			const lengthFull = this.length;
			const lengthRead = buffer.length;
			let pos = this.cursor;

			while(pos < lengthFull) {
				readSync(this.target, buffer, 0, lengthRead, pos);

				const offsetTemp = buffer.indexOf(bufferData);

				if(offsetTemp > -1) {
					offset = pos + offsetTemp;

					break;
				}

				pos += 1024 * 1024;
			}
		}
		else {
			offset = this.target.indexOf(bufferData, this.cursor);
		}


		return offset > -1 ? this.#cursor = offset : offset;
	}
	/**
	 * Seeks to the beginning and then finds the first occurrence of the given data.
	 * @param {any} data Data to search for (will be passed to `Buffer.from`).
	 * @returns {number} The offset of the first occurrence, or -1 if not found.
	 */
	findFromHead(data) {
		this.seek(0);

		return this.find(data);
	}


	/**
	 * Unpacks a string that is prefixed by its length (length field + string data).
	 * @param {string} charLength The struct character for the length field (default is `'L'`).
	 * @param {boolean} returnBuffer If true, returns a Buffer; otherwise returns a string (default is false).
	 * @returns {string|Buffer}
	 */
	unpackString(charLength = 'L', returnBuffer = false) {
		const [length] = this.unpack(charLength);

		const result = this.slice(length, { wrap: false });

		return returnBuffer ? result : String(result);
	}


	/**
	 * Checks if the cursor has reached or passed the end of the data.
	 * @returns {boolean}
	 */
	isReach() {
		return this.cursor >= this.length;
	}

	/**
	 * Closes the underlying file descriptor if it is open.
	 */
	close() {
		if(this.#usingFileDescriptor && typeof this.#target == 'number') {
			try {
				closeSync(this.#target);
			}
			catch(error) {
				if(error.code != 'EBADF') { throw error; }
			}
		}
	}


	get [Symbol.toStringTag]() { return 'Biffer'; }

	[inspect.custom]() {
		return this.#usingFileDescriptor
			? `<Biffer${this.path ? ` path:${this.path}` : ''} cursor/length:${this.#cursor}/${this.#length})>`
			: `<Biffer cursor/length:${this.#cursor}/${this.#length} buffer:${this.#target.inspect().replace(/^<Buffer\s|>$/g, '')}>`;
	}
}

Object.freeze(Biffer.sizes$charStruct);
