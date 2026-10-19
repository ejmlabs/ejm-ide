//! A small sample project for exploring Workbench.
pub mod money;
pub mod orders;
pub mod payments;

#[derive(Clone, Debug)]
pub struct Order {
    pub key: String,
    pub items: Vec<money::LineItem>,
}

#[derive(Clone, Debug)]
pub struct Receipt {
    pub order_key: String,
    pub amount: money::Money,
}

#[derive(Debug)]
pub struct Error(pub String);

pub trait Store {
    fn find_receipt(&self, key: &str) -> Result<Option<Receipt>, Error>;
    fn save_receipt(&self, receipt: &Receipt) -> Result<(), Error>;
}
