// Fix the book class form submission
async function handleBookClassSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const classId = document.getElementById("book-class-id").value;
  const memberId = form.memberId.value;  // ✓ Correct field access
  const response = await fetch(`/api/classes/${classId}/book`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ memberId })
  });
  const result = await response.json();
  if (!response.ok) {
    showToast("Booking failed", result.error || "Unknown error");
    return;
  }
  document.getElementById("book-class-modal").close();
  showToast("Member booked", "They're on the class roster.");
}