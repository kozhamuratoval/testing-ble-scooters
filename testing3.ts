import noble, { Peripheral, Characteristic } from "@abandonware/noble";

const SERVICE_UUID = "6e400001b5a3f393e0a9e50e24dcca9e";
const STX = Buffer.from([0xa3, 0xa4]);
const DEVICE_KEY = Buffer.from("796F546D4B35307A", "hex"); // замени на свой, если известен

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

function buildFrame(cmd: number, data: Buffer, keyField?: Buffer): Buffer {
  const key = keyField || Buffer.alloc(8, 0x00);
  const rand = Math.floor(Math.random() * 256);
  const randBuf = Buffer.from([rand]);
  const xorVal = (rand + 0x32) & 0xff;

  const encrypted = Buffer.from(data.map((b) => b ^ xorVal));
  const body = Buffer.concat([randBuf, key, Buffer.from([cmd]), encrypted]);
  const len = Buffer.from([body.length + 1]);
  const crc = Buffer.from([crc8(Buffer.concat([len, body]))]);
  return Buffer.concat([STX, len, body, crc]);
}

function parseResponse(response: Buffer) {
  if (response.length < 5) throw new Error("Short response");
  const len = response[2];
  const body = response.slice(3, 3 + len - 1);
  const crcRecv = response[3 + len - 1];
  const crcCalc = crc8(Buffer.concat([Buffer.from([len]), body]));
  if (crcRecv !== crcCalc) throw new Error("CRC mismatch");
  const rand = body[0];
  const xorVal = (rand + 0x32) & 0xff;
  const data = Buffer.from(body.slice(10).map((b) => b ^ xorVal));
  return data;
}

async function testCombination(
  peripheral: Peripheral,
  writeUUID: string,
  notifyUUID: string,
  cmd: number
): Promise<boolean> {
  console.log(`\n🔹 Тест: WRITE=${writeUUID.slice(-4)}, NOTIFY=${notifyUUID.slice(-4)}, CMD=${cmd.toString(16)}`);

  await peripheral.connectAsync();
  const { characteristics } =
    await peripheral.discoverSomeServicesAndCharacteristicsAsync(
      [SERVICE_UUID],
      [writeUUID, notifyUUID]
    );

  const writeChar = characteristics.find((c) => c.uuid === writeUUID) as Characteristic;
  const notifyChar = characteristics.find((c) => c.uuid === notifyUUID) as Characteristic;
  if (!writeChar || !notifyChar) throw new Error("Не найдены нужные характеристики");

  const frame = buildFrame(cmd, DEVICE_KEY);
  console.log("→ Отправляем:", frame.toString("hex"));

  const responsePromise = new Promise<Buffer>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout")), 30000);
    notifyChar.once("data", (data) => {
      clearTimeout(timeout);
      resolve(data);
    });
  });

  await notifyChar.subscribeAsync();
  await new Promise((r) => setTimeout(r, 300));
  await writeChar.writeAsync(frame, true);

  try {
    const resp = await responsePromise;
    console.log("✅ Ответ:", resp.toString("hex"));
    const commKey = parseResponse(resp);
    console.log("✅ Communication Key:", commKey.toString("hex"));
    await notifyChar.unsubscribeAsync();
    await peripheral.disconnectAsync();
    return true;
  } catch (err) {
    console.log("❌ Нет ответа");
    await notifyChar.unsubscribeAsync().catch(() => {});
    await peripheral.disconnectAsync().catch(() => {});
    return false;
  }
}

async function main() {
  console.log("🔍 Сканирую устройства Omni IoT...");
  noble.on("stateChange", async (state) => {
    if (state === "poweredOn") await noble.startScanningAsync([SERVICE_UUID], false);
  });

  noble.on("discover", async (peripheral: Peripheral) => {
    const adv = peripheral.advertisement;
    console.log(`\nНайдено: ${adv.localName || "?"} (${peripheral.address})`);
    await noble.stopScanningAsync();

    const combos = [
      { write: "6e400002b5a3f393e0a9e50e24dcca9e", notify: "6e400003b5a3f393e0a9e50e24dcca9e", cmd: 0x01 },
      { write: "6e400002b5a3f393e0a9e50e24dcca9e", notify: "6e400003b5a3f393e0a9e50e24dcca9e", cmd: 0x10 },
      { write: "6e400003b5a3f393e0a9e50e24dcca9e", notify: "6e400002b5a3f393e0a9e50e24dcca9e", cmd: 0x01 },
      { write: "6e400003b5a3f393e0a9e50e24dcca9e", notify: "6e400002b5a3f393e0a9e50e24dcca9e", cmd: 0x10 },
    ];

    for (const combo of combos) {
      try {
        const ok = await testCombination(peripheral, combo.write, combo.notify, combo.cmd);
        if (ok) {
          console.log("\n🎉 Найдена рабочая комбинация!");
          process.exit(0);
        }
      } catch (e) {
        console.error("Ошибка:", e);
      }
    }

    console.log("\n🚫 Устройство не ответило ни на одну комбинацию.");
    process.exit(0);
  });
}

main().catch((e) => console.error(e));
