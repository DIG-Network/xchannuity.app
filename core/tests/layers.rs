//! Regression guards for the layer refactor: the composed CatLayer<StreamLayer>
//! must produce byte-identical puzzle hashes and round-trip through parse.
use chia_protocol::Bytes32;
use chia_sdk_driver::{CatLayer, Layer, Puzzle, SpendContext};
use xchannuity_core::layers::stream::StreamLayer;

const START: u64 = 1000;
const END: u64 = 2000;

fn fixture() -> StreamLayer {
    StreamLayer::new(Bytes32::new([3u8; 32]), Some(Bytes32::new([9u8; 32])), END, START)
}

#[test]
fn stream_layer_construct_matches_curry_hash() {
    let mut ctx = SpendContext::new();
    let layer = fixture();
    let ptr = layer.construct_puzzle(&mut ctx).unwrap();
    let constructed: Bytes32 = ctx.tree_hash(ptr).into();
    let declared: Bytes32 = layer.inner_puzzle_hash().into();
    assert_eq!(constructed, declared, "construct_puzzle hash must equal inner_puzzle_hash");
}

#[test]
fn cat_stream_parse_round_trips() {
    let mut ctx = SpendContext::new();
    let asset_id = Bytes32::new([7u8; 32]);
    let layer = CatLayer::new(asset_id, fixture());
    let ptr = layer.construct_puzzle(&mut ctx).unwrap();
    let parsed = CatLayer::<StreamLayer>::parse_puzzle(&ctx, Puzzle::parse(&ctx, ptr))
        .unwrap()
        .expect("parses as CatLayer<StreamLayer>");
    assert_eq!(parsed.asset_id, asset_id);
    assert_eq!(parsed.inner_puzzle.owner_puzzle_hash(), fixture().owner_puzzle_hash());
    assert_eq!(parsed.inner_puzzle.clawback_ph, fixture().clawback_ph);
    assert_eq!(parsed.inner_puzzle.end_time, END);
    assert_eq!(parsed.inner_puzzle.last_payment_time, START);
}
