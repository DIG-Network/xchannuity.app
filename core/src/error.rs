use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("driver error: {0}")]
    Driver(#[from] chia_sdk_driver::DriverError),

    #[error("hex decode: {0}")]
    Hex(#[from] hex::FromHexError),

    #[error("clvm: {0}")]
    Clvm(#[from] clvmr::error::EvalErr),

    #[error("to-clvm: {0}")]
    ToClvm(#[from] clvm_traits::ToClvmError),

    #[error("from-clvm: {0}")]
    FromClvm(#[from] clvm_traits::FromClvmError),

    #[error("clawbackable annuity cannot be listed for sale")]
    ClawbackableNotSellable,

    #[error("unsupported denomination asset id: {0}")]
    UnsupportedAsset(String),

    #[error("transfer requires a new recipient")]
    TransferNeedsRecipient,

    #[error("{0}")]
    Custom(String),
}

pub type Result<T> = std::result::Result<T, Error>;
