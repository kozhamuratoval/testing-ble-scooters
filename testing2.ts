import noble, { Peripheral, Characteristic } from "@abandonware/noble";

// UUID из спецификации Omni IoT (в этом варианте — ПЕРЕСТАВЛЕНЫ)
const SERVICE_UUID = "6e400001b5a3f393e0a9e50e24dcca9e";
const WRITE_CHAR_UUID = "6e400003b5a3f393e0a9e50e24dcca9e"; // ⚠️ теперь write → ...0003
const NOTIFY_CHAR_UUID = "6e400002b5a3f393e0a9e50e24dcca9e"; // ⚠️ теперь notify → ...0002

// Константы
const STX = Buffer.from([0xa3, 0xa4]);
const DEVICE_KEY = Buffer.from("796F546D4B35307A", "hex"); // пример "yOTmK50z"

// CRC8 (poly = 0x07)
function crc8(data: Buffer, poly = 0x07, init = 0x00): number {
  let crc = init;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      if (crc & 0x80) crc = ((crc << 1) & 0xff) ^ poly;
      else crc = (crc << 1) & 0xff;
    }
  }
  return crc & 0xff;
}

// Построение BLE-фрейма (0x01 handshake)
function buildFrame(cmd: number, data: Buffer, keyField?: Buffer): Buffer {
  const key = keyField || Buffer.alloc(8, 0x00);
  const rand = Math.floor(Math.random() * 256);
  const randBuf = Buffer.from([rand]);
  const xorVal = (rand + 0x32) & 0xff; // важное изменение

  const encrypted = Buffer.from(data.map((b) => b ^ xorVal));
  const body = Buffer.concat([randBuf, key, Buffer.from([cmd]), encrypted]);
  const len = Buffer.from([body.length + 1]); // +CRC
  const crc = Buffer.from([crc8(Buffer.concat([len, body]))]); // CRC по LEN+BODY
  return Buffer.concat([STX, len, body, crc]);
}

// Парсинг ответа
function parseResponse(response: Buffer) {
  if (response.length < 5) throw new Error("Short response");
  if (!response.slice(0, 2).equals(STX)) throw new Error("Bad STX");
  const len = response[2];
  const body = response.slice(3, 3 + len - 1);
  const crcRecv = response[3 + len - 1];
  const crcCalc = crc8(Buffer.concat([Buffer.from([len]), body]));
  if (crcRecv !== crcCalc)
    throw new Error(`CRC mismatch: got ${crcRecv}, calc ${crcCalc}`);

  const rand = body[0];
  const keyField = body.slice(1, 9);
  const cmd = body[9];
  const encData = body.slice(10);
  const xorVal = (rand + 0x32) & 0xff;
  const data = Buffer.from(encData.map((b) => b ^ xorVal));
  return { rand, keyField, cmd, data };
}

// Подключение и получение Communication Key
async function connectAndHandshake(peripheral: Peripheral): Promise<void> {
  await peripheral.connectAsync();
  console.log(`Connected to ${peripheral.address}`);

  const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
    [SERVICE_UUID],
    [WRITE_CHAR_UUID, NOTIFY_CHAR_UUID]
  );

  const writeChar = characteristics.find(
    (c) => c.uuid === WRITE_CHAR_UUID
  ) as Characteristic;
  const notifyChar = characteristics.find(
    (c) => c.uuid === NOTIFY_CHAR_UUID
  ) as Characteristic;

  if (!writeChar || !notifyChar)
    throw new Error("Required characteristics not found");

  const frame = buildFrame(0x01, DEVICE_KEY);
  console.log("Sending handshake frame:", frame.toString("hex"));

  const responsePromise = new Promise<Buffer>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout")), 30000); // 30 сек
    notifyChar.once("data", (data) => {
      clearTimeout(timeout);
      resolve(data);
    });
  });

  await notifyChar.subscribeAsync();
  await new Promise((r) => setTimeout(r, 300)); // пауза перед write
  await writeChar.writeAsync(frame, true);

  const resp = await responsePromise;
  console.log("Raw response:", resp.toString("hex"));
  const parsed = parseResponse(resp);
  console.log("Parsed:", parsed);
  console.log("Communication Key:", parsed.data.toString("hex"));

  await notifyChar.unsubscribeAsync();
  await peripheral.disconnectAsync();
}

// Главная функция
async function main() {
  console.log("Scanning for Omni IoT devices...");
  noble.on("stateChange", async (state) => {
    if (state === "poweredOn") {
      await noble.startScanningAsync([SERVICE_UUID], false);
    } else {
      await noble.stopScanningAsync();
    }
  });

  noble.on("discover", async (peripheral: Peripheral) => {
    const adv = peripheral.advertisement;
    const uuids = adv.serviceUuids?.map((u) => u.toLowerCase()) || [];
    if (uuids.includes(SERVICE_UUID)) {
      console.log(
        `Found target: ${peripheral.address || "(unknown)"} (${adv.localName || "?"})`
      );
      await noble.stopScanningAsync();
      try {
        await connectAndHandshake(peripheral);
      } catch (e) {
        console.error("Handshake failed:", e);
      } finally {
        process.exit(0);
      }
    }
  });
}

main().catch((err) => console.error("Error:", err));
