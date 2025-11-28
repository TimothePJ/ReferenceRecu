// Keep exactly the same dropdown population strategy as your other widgets.
(function () {
  function populateFirstColumnDropdown(values) {
    const dropdown = document.getElementById('firstColumnDropdown');
    if (!dropdown) return;

    const currentSelection = dropdown.value;

    values.sort((a, b) => a.localeCompare(b));

    dropdown.innerHTML = '<option value="">Selectionner un projet</option>';

    values.forEach(value => {
      if (value) {
        const option = document.createElement('option');
        option.value = value;
        option.text = value;
        dropdown.appendChild(option);
      }
    });

    dropdown.value = currentSelection || '';
  }

  window.populateFirstColumnDropdown = populateFirstColumnDropdown;
})();
