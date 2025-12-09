import noble, { Peripheral, Characteristic } from "@abandonware/noble";

// ==== Omni UART UUIDs (по спецификации) ====
const SERVICE_UUID = "6e400001b5a3f393e0a9e50e24dcca9e";
const WRITE_CHAR_UUID = "6e400002b5a3f393e0a9e50e24dcca9e";  // Host -> IoT
const NOTIFY_CHAR_UUID = "6e400003b5a3f393e0a9e50e24dcca9e"; // IoT  -> Host

// ==== Константы протокола ====
const STX0 = 0xa3;
const STX1 = 0xa4;

// Default device key из протокола (может отличаться у ваших устройств!)
const DEVICE_KEY = Buffer.from("796F546D4B35307A", "hex"); // "yOTmK50z"

// ==== CRC8 по таблице из Appendix III Omni ====
const CRC8_TABLE: number[] = [
  0, 94, 188, 226, 97, 63, 221, 131,
  194, 156, 126, 32, 163, 253, 31, 65,
  157, 195, 33, 127, 252, 162, 64, 30,
  95, 1, 227, 189, 62, 96, 130, 220,
  35, 125, 159, 193, 66, 28, 254, 160,
  225, 191, 93, 3, 128, 222, 60, 98,
  190, 224, 2, 92, 223, 129, 99, 61,
  124, 34, 192, 158, 29, 67, 161, 255,
  70, 24, 250, 164, 39, 121, 155, 197,
  132, 218, 56, 102, 229, 187, 89, 7,
  219, 133, 103, 57, 186, 228, 6, 88,
  25, 71, 165, 251, 120, 38, 196, 154,
  101, 59, 217, 135, 4, 90, 184, 230,
  167, 249, 27, 69, 198, 152, 122, 36,
  248, 166, 68, 26, 153, 199, 37, 123,
  58, 100, 134, 216, 91, 5, 231, 185,
  140, 210, 48, 110, 237, 179, 81, 15,
  78, 16, 242, 172, 47, 113, 147, 205,
  17, 79, 173, 243, 112, 46, 204, 146,
  211, 141, 111, 49, 178, 236, 14, 80,
  175, 241, 19, 77, 206, 144, 114, 44,
  109, 51, 209, 143, 12, 82, 176, 238,
  50, 108, 142, 208, 83, 13, 239, 177,
  240, 174, 76, 18, 145, 207, 45, 115,
  202, 148, 118, 40, 171, 245, 23, 73,
  8, 86, 180, 234, 105, 55, 213, 139,
  87, 9, 235, 181, 54, 104, 138, 212,
  149, 203, 41, 119, 244, 170, 72, 22,
  233, 183, 85, 11, 136, 214, 52, 106,
  43, 117, 151, 201, 74, 20, 246, 168,
  116, 42, 200, 150, 21, 75, 169, 247,
  182, 232, 10, 84, 215, 137, 107, 53
];

function crc8Omni(buf: Buffer): number {
  let crc = 0;
  for (const b of buf) {
    crc = CRC8_TABLE[crc ^ b];
  }
  return crc & 0xff;
}

// ====================================================================
//  Построение BLE-фрейма по ОФИЦИАЛЬНОЙ схеме (2.2 + 2.5.1)
// ====================================================================

/**
 * Общий билдер BLE-кадра Omni.
 * @param cmd      код команды (0x01, 0x05, 0x15, 0x31 и т.д.)
 * @param data     DATA (то, что идёт после CMD), длина = LEN
 * @param keyByte  1-байтовый communication key (для 0x01 = 0x00)
 */
function buildBleFrame(cmd: number, data: Buffer, keyByte: number): Buffer {
  const len = data.length;          // LEN = длина DATA
  const rand = Math.floor(Math.random() * 256) & 0xff; // исходный RAND
  const rand1 = (rand + 0x32) & 0xff;                  // RAND1 = RAND + 0x32

  // Пэйлоад без STX и CRC: [LEN][RAND1][KEY'][CMD'][DATA']
  const payload = Buffer.alloc(4 + len);

  // 1. LEN
  payload[0] = len;

  // 2. RAND1 (уже с +0x32)
  payload[1] = rand1;

  // 3. пока НЕзашифрованный KEY и CMD
  payload[2] = keyByte;   // для 0x01 это 0x00
  payload[3] = cmd;

  // 4. незашифрованные DATA
  data.copy(payload, 4);

  // 5. XOR оригинальным RAND ВСЁ, начиная с KEY (индекс 2)
  for (let i = 2; i < payload.length; i++) {
    payload[i] = payload[i] ^ rand;
  }

  // 6. CRC8 по всему payload (LEN..последний байт DATA')
  const crc = crc8Omni(payload);

  // Финальный кадр: [STX0][STX1][payload...][CRC]
  const frame = Buffer.alloc(2 + payload.length + 1);
  frame[0] = STX0;
  frame[1] = STX1;
  payload.copy(frame, 2);
  frame[frame.length - 1] = crc;

  return frame;
}

/**
 * Специальный билдер для 0x01 Verify Device KEY.
 * DATA = 8 байт DEVICE KEY, KEY = 0x00.
 */
function buildHandshakeFrame(deviceKey: Buffer): Buffer {
  if (deviceKey.length !== 8) {
    throw new Error("Device KEY must be exactly 8 bytes");
  }
  return buildBleFrame(0x01, deviceKey, 0x00);
}

// ====================================================================
//  Разбор и расшифровка ответа 0x01 (получение session / communication key)
// ====================================================================

interface HandshakeResult {
  ok: boolean;
  status: number;
  sessionKey: number;
  rawCommKeyField: number;
}

function parseHandshakeResponse(resp: Buffer): HandshakeResult {
  if (resp.length < 2 + 4 + 2 + 1) {
    throw new Error("Handshake response too short");
  }
  if (resp[0] !== STX0 || resp[1] !== STX1) {
    throw new Error("Bad STX in response");
  }

  const crcRecv = resp[resp.length - 1];
  const payload = resp.slice(2, resp.length - 1); // LEN..DATA'

  const crcCalc = crc8Omni(payload);
  if (crcCalc !== crcRecv) {
    throw new Error(`CRC mismatch: got 0x${crcRecv.toString(16)}, calc 0x${crcCalc.toString(16)}`);
  }

  const len = payload[0]; // должно быть 0x02
  const rand1 = payload[1];
  const rand = (rand1 - 0x32) & 0xff;

  // Расшифровываем KEY, CMD и DATA: XOR с исходным RAND
  const decrypted = Buffer.from(payload); // копия
  for (let i = 2; i < decrypted.length; i++) {
    decrypted[i] ^= rand;
  }

  const keyField = decrypted[2]; // Communication key (тот же, что и DATA[1] обычно)
  const cmd = decrypted[3];      // должен быть 0x01
  if (cmd !== 0x01) {
    throw new Error(`Unexpected CMD in handshake response: 0x${cmd.toString(16)}`);
  }

  if (len < 1) {
    throw new Error("LEN too small in handshake response");
  }
  const status = decrypted[4];       // Verification status: 1=success, 0=failure
  const sessionKey = len >= 2 ? decrypted[5] : 0; // Communication KEY из DATA[1]

  return {
    ok: status === 1,
    status,
    sessionKey,
    rawCommKeyField: keyField
  };
}

// ====================================================================
//  Подключение к скутеру и выполнение handshake
// ====================================================================

async function connectAndHandshake(peripheral: Peripheral): Promise<void> {
  console.log(`\n🔗 Connecting to ${peripheral.address} (${peripheral.advertisement.localName || "?"})...`);
  await peripheral.connectAsync();
  console.log("✅ Connected");

  const { characteristics } =
    await peripheral.discoverSomeServicesAndCharacteristicsAsync(
      [SERVICE_UUID],
      [WRITE_CHAR_UUID, NOTIFY_CHAR_UUID]
    );

  const writeChar = characteristics.find(c => c.uuid === WRITE_CHAR_UUID) as Characteristic | undefined;
  const notifyChar = characteristics.find(c => c.uuid === NOTIFY_CHAR_UUID) as Characteristic | undefined;

  if (!writeChar || !notifyChar) {
    throw new Error("WRITE or NOTIFY characteristic not found (check UUIDs)");
  }

  // Подписка на notify (включает CCCD)
  await notifyChar.subscribeAsync();
  console.log("🔔 Notifications enabled");

  // Готовим обещание на ответ
  const responsePromise = new Promise<Buffer>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Handshake timeout (no 0x01 response)")), 10000);

    notifyChar.once("data", (data) => {
      clearTimeout(timeout);
      resolve(data);
    });
  });

  // Строим и отправляем handshake-кадр 0x01
  const frame = buildHandshakeFrame(DEVICE_KEY);
  console.log("➡️ Sending 0x01 handshake frame:", frame.toString("hex"));
  await writeChar.writeAsync(frame, true); // withResponse=true

  // Ждём ответ
  const rawResp = await responsePromise;
  console.log("📩 Raw 0x01 response:", rawResp.toString("hex"));

  const parsed = parseHandshakeResponse(rawResp);
  console.log("✅ Handshake parsed:", parsed);
  console.log("🔑 Session / Communication KEY (byte): 0x" + parsed.sessionKey.toString(16));

  await notifyChar.unsubscribeAsync().catch(() => {});
  await peripheral.disconnectAsync().catch(() => {});
  console.log("🏁 Done, disconnected");
}

// ====================================================================
//  main: сканируем и как только находим Omni-девайс — делаем handshake
// ====================================================================

async function main() {
  console.log("🔎 Scanning for Omni IoT scooters...");

  noble.on("stateChange", async (state) => {
    if (state === "poweredOn") {
      // Сканируем по сервису Omni UART
      await noble.startScanningAsync([SERVICE_UUID], false);
    } else {
      await noble.stopScanningAsync();
    }
  });

  noble.on("discover", async (peripheral: Peripheral) => {
    const adv = peripheral.advertisement;
    const uuids = (adv.serviceUuids || []).map(u => u.toLowerCase());

    if (!uuids.includes(SERVICE_UUID)) {
      return;
    }

    console.log(
      `\n🚲 Found target: ${peripheral.address || "(no-mac)"} (${adv.localName || "?"})`
    );
    await noble.stopScanningAsync();

    try {
      await connectAndHandshake(peripheral);
    } catch (e) {
      console.error("❌ Handshake failed:", e);
    } finally {
      process.exit(0);
    }
  });
}

main().catch((err) => console.error("Fatal error:", err));
