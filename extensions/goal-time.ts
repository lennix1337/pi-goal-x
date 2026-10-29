/** Ledger timestamps are UTC ISO; people read them in the machine's local time zone. */
export function localStamp(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const pad = (value: number) => String(value).padStart(2, "0");
	const offset = -date.getTimezoneOffset();
	const sign = offset < 0 ? "-" : "+";
	const zone = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${zone}`;
}

/** Local wall-clock time (HH:MM:SS) of a ledger timestamp. */
export function localClock(iso: string): string {
	const stamp = localStamp(iso);
	return stamp === iso ? iso.slice(11, 19) : stamp.slice(11, 19);
}
