import noble, { Peripheral, Characteristic, Service } from "@abandonware/noble";

const UART_SERVICE = "6e400001b5a3f393e0a9e50e24dcca9e";
const UART_WRITE = "6e400002b5a3f393e0a9e50e24dcca9e";
const UART_NOTIFY = "6e400003b5a3f393e0a9e50e24dcca9e";
const DEVICE_INFO_SERVICE = "180a";

// просто для теста пришлём потом 1 байт
const TEST_PAYLOAD = Buffer.from([0x01]);

async function readIfExists(
  peripheral: Peripheral,
  serviceUUID: string,
  charUUID: string
): Promise<string | null> {
  try {
    const { characteristics } =
      await peripheral.discoverSomeServicesAndCharacteristicsAsync(
        [serviceUUID],
        [charUUID]
      );
    const ch = characteristics[0];
    if (!ch) return null;
    const data = await ch.readAsync();
    return data.toString("utf8");
  } catch (_) {
    return null;
  }
}

async function main() {
  console.log("🔎 Сканирую (ищу Scooter)...");
  noble.on("stateChange", async (state) => {
    if (state === "poweredOn") {
      await noble.startScanningAsync([], false);
    }
  });

  noble.on("discover", async (peripheral: Peripheral) => {
    const name = peripheral.advertisement.localName || "";
    if (!name.toLowerCase().includes("scooter")) return;

    console.log(`\n🚲 Найден: ${name} (${peripheral.address || "no-mac"})`);
    await noble.stopScanningAsync();
    await peripheral.connectAsync();
    console.log("✅ Подключились");

    // 1) выведем GATT
    const services: Service[] = await peripheral.discoverServicesAsync([]);
    console.log("📜 Сервисы:");
    for (const s of services) {
      console.log(`  - ${s.uuid}`);
      const chars = await s.discoverCharacteristicsAsync([]);
      for (const c of chars) {
        console.log(`      • ${c.uuid} props=${JSON.stringify(c.properties)}`);
      }
    }

    // 2) пробуем вычитать Device Info
    console.log("\n📦 Device Information:");
    const man = await readIfExists(peripheral, DEVICE_INFO_SERVICE, "2a29"); // manufacturer
    const model = await readIfExists(peripheral, DEVICE_INFO_SERVICE, "2a24"); // model
    const serial = await readIfExists(peripheral, DEVICE_INFO_SERVICE, "2a25"); // serial
    const fw = await readIfExists(peripheral, DEVICE_INFO_SERVICE, "2a26"); // firmware
    const hw = await readIfExists(peripheral, DEVICE_INFO_SERVICE, "2a27"); // hardware
    const sw = await readIfExists(peripheral, DEVICE_INFO_SERVICE, "2a28"); // software
    console.log("  Manufacturer:", man);
    console.log("  Model:", model);
    console.log("  Serial:", serial);
    console.log("  Firmware:", fw);
    console.log("  Hardware:", hw);
    console.log("  Software:", sw);

    // 3) подпишемся на UART notify
    const { characteristics } =
      await peripheral.discoverSomeServicesAndCharacteristicsAsync(
        [UART_SERVICE],
        [UART_WRITE, UART_NOTIFY]
      );
    const writeChar = characteristics.find((c) => c.uuid === UART_WRITE);
    const notifyChar = characteristics.find((c) => c.uuid === UART_NOTIFY);

    if (!writeChar || !notifyChar) {
      console.log("❌ UART-характеристики не найдены");
      process.exit(0);
    }

    notifyChar.on("data", (data) => {
      console.log("📩 notify:", data.toString("hex"), "| ascii:", data.toString("utf8"));
    });
    await notifyChar.subscribeAsync();
    console.log("🔔 Подписались на notify");

    // 4) тестово что-то пошлём — просто чтобы увидеть, реагирует ли оно на сырой байт
    // (это безопасно: 0x01 часто игнорируется)
    await new Promise((r) => setTimeout(r, 300));
    console.log("➡️ Пошлём тестовый байт 0x01 в UART write");
    await writeChar.writeAsync(TEST_PAYLOAD, true).catch(() =>
      writeChar.writeAsync(TEST_PAYLOAD, false)
    );

    console.log("⏳ Слушаем 30 секунд...");
    await new Promise((r) => setTimeout(r, 30000));

    await notifyChar.unsubscribeAsync().catch(() => {});
    await peripheral.disconnectAsync().catch(() => {});
    console.log("🏁 Готово");
    process.exit(0);
  });
}

main().catch((e) => console.error(e));
