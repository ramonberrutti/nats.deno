/*
 * Copyright 2022-2023 The NATS Authors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  cleanup,
  jetstreamServerConf,
  setup,
} from "../../tests/helpers/mod.ts";
import { initStream } from "./jstest_util.ts";
import { AckPolicy, DeliverPolicy } from "../jsapi_types.ts";
import { assertEquals } from "https://deno.land/std@0.200.0/assert/assert_equals.ts";
import { Empty } from "../../nats-base-client/encoders.ts";
import { StringCodec } from "../../nats-base-client/codec.ts";
import { deferred } from "../../nats-base-client/util.ts";
import { assertRejects } from "https://deno.land/std@0.200.0/assert/assert_rejects.ts";
import { nanos } from "../jsutil.ts";
import { NatsConnectionImpl } from "../../nats-base-client/nats.ts";
import { PullConsumerMessagesImpl } from "../consumer.ts";
import { syncIterator } from "../../nats-base-client/core.ts";
import { assertExists } from "https://deno.land/std@0.200.0/assert/assert_exists.ts";

Deno.test("consumers - fetch no messages", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());

  const { stream } = await initStream(nc);
  const jsm = await nc.jetstreamManager();
  await jsm.consumers.add(stream, {
    durable_name: "b",
    ack_policy: AckPolicy.Explicit,
  });

  const js = nc.jetstream();
  const consumer = await js.consumers.get(stream, "b");
  const iter = await consumer.fetch({
    max_messages: 100,
    expires: 1000,
  });
  for await (const m of iter) {
    m.ack();
  }
  assertEquals(iter.getReceived(), 0);
  assertEquals(iter.getProcessed(), 0);

  await cleanup(ns, nc);
});

Deno.test("consumers - fetch less messages", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());

  const { stream, subj } = await initStream(nc);
  const js = nc.jetstream();
  await js.publish(subj, Empty);

  const jsm = await nc.jetstreamManager();
  await jsm.consumers.add(stream, {
    durable_name: "b",
    ack_policy: AckPolicy.Explicit,
  });

  const consumer = await js.consumers.get(stream, "b");
  assertEquals((await consumer.info(true)).num_pending, 1);
  const iter = await consumer.fetch({ expires: 1000, max_messages: 10 });
  for await (const m of iter) {
    m.ack();
  }
  assertEquals(iter.getReceived(), 1);
  assertEquals(iter.getProcessed(), 1);

  await cleanup(ns, nc);
});

Deno.test("consumers - fetch exactly messages", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());

  const { stream, subj } = await initStream(nc);
  const sc = StringCodec();
  const js = nc.jetstream();
  await Promise.all(
    new Array(200).fill("a").map((_, idx) => {
      return js.publish(subj, sc.encode(`${idx}`));
    }),
  );

  const jsm = await nc.jetstreamManager();

  await jsm.consumers.add(stream, {
    durable_name: "b",
    ack_policy: AckPolicy.Explicit,
  });

  const consumer = await js.consumers.get(stream, "b");
  assertEquals((await consumer.info(true)).num_pending, 200);

  const iter = await consumer.fetch({ expires: 5000, max_messages: 100 });
  for await (const m of iter) {
    m.ack();
  }
  assertEquals(iter.getReceived(), 100);
  assertEquals(iter.getProcessed(), 100);

  await cleanup(ns, nc);
});

// Deno.test("consumers - fetch deleted consumer", async () => {
//   const { ns, nc } = await setup(jetstreamServerConf({}));
//   const { stream } = await initStream(nc);
//   const jsm = await nc.jetstreamManager();
//   await jsm.consumers.add(stream, {
//     durable_name: "a",
//     ack_policy: AckPolicy.Explicit,
//   });
//
//   const js = nc.jetstream();
//   const c = await js.consumers.get(stream, "a");
//   const iter = await c.fetch({
//     expires: 30000,
//   });
//   const dr = deferred();
//   setTimeout(() => {
//     jsm.consumers.delete(stream, "a")
//       .then(() => {
//         dr.resolve();
//       });
//   }, 1000);
//   await assertRejects(
//     async () => {
//       for await (const _m of iter) {
//         // nothing
//       }
//     },
//     Error,
//     "consumer deleted",
//   );
//   await dr;
//   await cleanup(ns, nc);
// });

Deno.test("consumers - fetch listener leaks", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await nc.jetstreamManager();
  await jsm.streams.add({ name: "messages", subjects: ["hello"] });

  const js = nc.jetstream();
  await js.publish("hello");

  await jsm.consumers.add("messages", {
    durable_name: "myconsumer",
    deliver_policy: DeliverPolicy.All,
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(3000),
    max_waiting: 500,
  });

  const nci = nc as NatsConnectionImpl;
  const base = nci.protocol.listeners.length;

  const consumer = await js.consumers.get("messages", "myconsumer");

  let done = false;
  while (!done) {
    const iter = await consumer.fetch({
      max_messages: 1,
    }) as PullConsumerMessagesImpl;
    for await (const m of iter) {
      assertEquals(nci.protocol.listeners.length, base);
      m?.nak();
      if (m.info.redeliveryCount > 100) {
        done = true;
      }
    }
  }

  assertEquals(nci.protocol.listeners.length, base);

  await cleanup(ns, nc);
});

Deno.test("consumers - fetch sync", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const jsm = await nc.jetstreamManager();
  await jsm.streams.add({ name: "messages", subjects: ["hello"] });

  const js = nc.jetstream();
  await js.publish("hello");
  await js.publish("hello");

  await jsm.consumers.add("messages", {
    durable_name: "c",
    deliver_policy: DeliverPolicy.All,
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(3000),
    max_waiting: 500,
  });

  const consumer = await js.consumers.get("messages", "c");
  const iter = await consumer.fetch({ max_messages: 2 });
  const sync = syncIterator(iter);
  assertExists(await sync.next());
  assertExists(await sync.next());
  assertEquals(await sync.next(), null);
  await cleanup(ns, nc);
});
