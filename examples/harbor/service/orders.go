package service

// calculateTotal adds the line item amounts in cents.
func calculateTotal(amounts []int) int {
	total := 0
	for _, amount := range amounts {
		total += amount
	}
	return total
}

func settleOrder(amounts []int) int {
	return calculateTotal(amounts)
}
