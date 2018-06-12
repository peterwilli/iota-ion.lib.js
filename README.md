# IOTA ION

High-troughput off-tangle data-transfer, powered by IOTA!

----

ION is a WebRTC library allowing for fast transfer of data between 2 parties (many-to-many will be supported, but it's currently not in the scope of the beta)

It can mainly be seen as a second layer on top of the Tangle that every IOTA node is compatible with. It's like Lightning for IOTA data transfer: Only the connection and negotiation between clients is pushed to the Tangle (and takes some time). After that, there is a **direct** p2p connection between 2 clients.

## Possible Applications

Practically everything that is related to IoT or security, but in the need of large data transfer.

 - Realtime security camera's
 - CCTV surveillance (imagine having a connection set up with ION, and then publish a summary of the video, processed by AI, to the Tangle)
 - Video conversations (check out [ion.ooo](https://ion.ooo)!)
 - Decentralized multiplayer video games.
 - IOTA Flash? (That's why I built it to begin with)

## Demo's

- [ion.ooo](https://ion.ooo)

## How to get started

Soon

## What is WebRTC?

WebRTC is a peer-to-peer connection API in every modern web browser. Normally, when you set up a WebRTC connection, there is a centralized signaling server, that handles the identification and negotiation of the clients. Then, there is a STUN server that penetrates the firewall and allows direct and secured connections between 2 or more parties. ION is using regular IOTA Nodes as a substitute for those signaling servers. Unfortunately, a STUN server cannot be replicated as of now yet, but that's not a big problem (as anyone can be a STUN server, but not everyone can be a signaling server)

## Donate

IOTA donations accepted at: `W9WOORJCIUJTSBHHQNMCFCWYDFLOYJGPJDHDAULHJQEHHRUTYHFL9AHFIQGJABYKCLXRLHPEHKTOPGXFBUMQBKKLIW` (it's a Ledger Nano S address ;))

Donations are being used to support the development of ION and the ion.ooo example. It's not easy to build a secondary layer that facilitates connections on top of the Tangle. We're basically building a distributed system on top of another distributed system.

Thank you very much!
