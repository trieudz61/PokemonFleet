//! PokemonFleet license verification.
//!
//! Each install gets a stable `machine_id` derived from
//! `SHA256(MachineGuid|MAC)`. We post `{key, machine_id}` to the worker
//! and cache the result in the SQLite store.

pub mod verifier;
