"""Match payment receipts to the orders in a daily export."""
from dataclasses import dataclass


@dataclass(frozen=True)
class Receipt:
    order_key: str
    amount: int


def total_received(receipts: list[Receipt]) -> int:
    """Return the total received, in integer cents."""
    return sum(receipt.amount for receipt in receipts)


def reconcile(expected: int, receipts: list[Receipt]) -> int:
    """Return the difference between expected and received funds."""
    return expected - total_received(receipts)
