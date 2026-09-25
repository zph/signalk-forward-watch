const test = require('node:test');
const assert = require('node:assert/strict');
const OpenCPNOutput = require('../plugin/opencpn-output');

function makeOutput() {
  const messages = [];
  const app = {
    handleMessage: (source, message) => messages.push({ source, message }),
    debug: () => {}
  };
  return { output: new OpenCPNOutput(app), messages };
}

function detection(class_name, cx, latitude = 43, longitude = -70) {
  return {
    class_name,
    cx,
    confidence: 0.8,
    position: { latitude, longitude }
  };
}

test('assigns simultaneous same-class detections distinct stable MMSIs left to right', () => {
  const { output, messages } = makeOutput();
  const inputs = [detection('boat', 0.9), detection('boat', 0.1), detection('boat', 0.5)];

  output.sendDetections(inputs);

  const targets = messages.map(({ message }) => ({
    context: message.context,
    name: message.updates[0].values.find(value => value.path === 'name').value
  }));
  assert.deepEqual(targets, [
    { context: 'vessels.urn:mrn:imo:mmsi:800000002', name: 'FW-BOAT-1 (80%)' },
    { context: 'vessels.urn:mrn:imo:mmsi:800000012', name: 'FW-BOAT-2 (80%)' },
    { context: 'vessels.urn:mrn:imo:mmsi:800000022', name: 'FW-BOAT-3 (80%)' }
  ]);
});

test('clears previous targets after they disappear and on stop', () => {
  const { output, messages } = makeOutput();
  output.sendDetections([detection('ship', 0.4), detection('kayak', 0.7)]);
  const activeContexts = messages.map(({ message }) => message.context);

  output.sendDetections([]);

  const cleared = messages.slice(2);
  assert.deepEqual(cleared.map(({ message }) => message.context), activeContexts);
  assert.ok(cleared.every(({ message }) =>
    message.updates[0].values.every(value => value.value === null)
  ));

  output.sendDetections([detection('log', 0.2)]);
  const stopContext = messages.at(-1).message.context;
  output.stop();
  assert.equal(messages.at(-1).message.context, stopContext);
  assert.ok(messages.at(-1).message.updates[0].values.every(value => value.value === null));
});

test('ignores unsupported classes and detections without valid positions', () => {
  const { output, messages } = makeOutput();
  output.sendDetections([
    detection('person', 0.2),
    { ...detection('boat', 0.6), position: { latitude: 43 } }
  ]);
  assert.equal(messages.length, 0);
});

test('caps each class at 99 fake targets', () => {
  const { output, messages } = makeOutput();
  output.sendDetections(Array.from({ length: 101 }, (_, i) => detection('debris', i / 101)));
  assert.equal(messages.length, 99);
  assert.equal(messages[98].message.context, 'vessels.urn:mrn:imo:mmsi:800000983');
});
